import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import OpenAI from "openai";
import { chromium } from "playwright";

dotenv.config();

const cfg = {
  jobsUrl: process.env.LINKEDIN_JOBS_URL || "",
  profileKeywords: splitCsv(process.env.PROFILE_KEYWORDS),
  excludeKeywords: splitCsv(process.env.EXCLUDE_KEYWORDS),
  excludeCompanies: splitCsv(process.env.EXCLUDE_COMPANIES),
  maxJobs: Number(process.env.MAX_JOBS || 10),
  jobsPageSize: Number(process.env.JOBS_PAGE_SIZE || 25),
  useStartPagination: String(process.env.USE_START_PAGINATION || "true").toLowerCase() === "true",
  maxContactsPerJob: Number(process.env.MAX_CONTACTS_PER_JOB || 5),
  dryRun: String(process.env.DRY_RUN || "true").toLowerCase() === "true",
  resumeUrl: process.env.RESUME_URL || "",
  candidateName: process.env.CANDIDATE_NAME || "Dhruv Rana",
  candidateSignature: process.env.CANDIDATE_SIGNATURE || "",
  noteTemplate: process.env.NOTE_TEMPLATE || "",
  sentThresholdPerJob: Number(process.env.SENT_THRESHOLD_PER_JOB || 5),
  sentThresholdPerCompany: Number(process.env.SENT_THRESHOLD_PER_COMPANY || 5),
  minCompanyMembers: Number(process.env.MIN_COMPANY_MEMBERS || 100),
  experienceFilterEnabled:
    String(process.env.EXPERIENCE_FILTER_ENABLED || "true").toLowerCase() === "true",
  preferredMinYears: Number(process.env.PREFERRED_MIN_YEARS || 5),
  preferredMaxYears: Number(process.env.PREFERRED_MAX_YEARS || 9),
  candidateYears: Number(process.env.CANDIDATE_YEARS || 7),
  internshipYears: Number(process.env.INTERNSHIP_YEARS || 1),
  internshipWeight: Number(process.env.INTERNSHIP_WEIGHT || 1),
  maxNoteChars: Number(process.env.MAX_NOTE_CHARS || 300),
  actionDelayMinMs: Number(process.env.ACTION_DELAY_MIN_MS || 1200),
  actionDelayMaxMs: Number(process.env.ACTION_DELAY_MAX_MS || 2800),
  jobDelayMinMs: Number(process.env.JOB_DELAY_MIN_MS || 4000),
  jobDelayMaxMs: Number(process.env.JOB_DELAY_MAX_MS || 9000),
  scrollDelayMinMs: Number(process.env.SCROLL_DELAY_MIN_MS || 900),
  scrollDelayMaxMs: Number(process.env.SCROLL_DELAY_MAX_MS || 2200),
  keepBrowserOpen: String(process.env.KEEP_BROWSER_OPEN || "false").toLowerCase() === "true",
  useGptMessage: String(process.env.USE_GPT_MESSAGE || "false").toLowerCase() === "true",
  gptTimeoutMs: Number(process.env.GPT_TIMEOUT_MS || 12000),
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAIKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAIDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.4-pro",
};

if (!cfg.jobsUrl || !cfg.resumeUrl || !cfg.noteTemplate) {
  console.error("Missing config. Copy .env.example to .env and fill values.");
  process.exit(1);
}

console.log("[INIT] Starting LinkedIn outreach run");
console.log(`[INIT] jobsUrl=${cfg.jobsUrl}`);
console.log(
  `[INIT] maxJobs=${cfg.maxJobs} maxContactsPerJob=${cfg.maxContactsPerJob} dryRun=${cfg.dryRun}`
);
console.log(
  `[INIT] noteTemplateLen=${cfg.noteTemplate.length} maxNoteChars=${cfg.maxNoteChars}`
);
console.log(`[INIT] candidateName=${cfg.candidateName}`);
console.log(`[INIT] keepBrowserOpen=${cfg.keepBrowserOpen}`);

const stateDir = path.resolve(".pw-state");
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}
const runStatePath = path.resolve(".linkedin-run-state.json");
const runState = loadRunState(runStatePath);
const gptClient = createGptClient(cfg);
let gptDisabledForRun = false;
const companyMemberEligibilityCache = new Map();

const context = await chromium.launchPersistentContext(stateDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});

const page = await context.newPage();
console.log("[BROWSER] New page opened");
await page.goto(cfg.jobsUrl, { waitUntil: "domcontentloaded" });
console.log(`[NAV] Opened jobs URL: ${page.url()}`);

await ensureLoggedIn(page, cfg.jobsUrl);
await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "post-login settle");

const jobs = await collectJobs(page, cfg.maxJobs);
console.log(`Found ${jobs.length} jobs.`);

for (const job of jobs) {
  const jobKey = getJobKey(job.url);
  const alreadySent = runState.jobs?.[jobKey]?.sentCount || 0;
  if (alreadySent >= cfg.sentThresholdPerJob) {
    console.log(
      `[JOB] Skipping ${jobKey}; already sent ${alreadySent}/${cfg.sentThresholdPerJob} referrals`
    );
    continue;
  }

  console.log(`[JOB] Evaluating: ${job.title} @ ${job.company || "Unknown Company"}`);
  if (job.company && isCompanyExcluded(job.company, cfg.excludeCompanies)) {
    console.log(`[JOB] Skipped company from blocklist: ${job.company}`);
    continue;
  }
  if (!isRelevant(job.title, cfg.profileKeywords, cfg.excludeKeywords)) {
    console.log("[JOB] Skipped as non-relevant by keyword filters");
    continue;
  }

  console.log(`\nJob: ${job.title} @ ${job.company}`);
  await openJob(page, job.url);
  const expCheck = await checkExperienceMatch(page, cfg);
  if (!expCheck.ok) {
    console.log(`[JOB] Skipped by experience filter: ${expCheck.reason}`);
    continue;
  }

  const companyUrl = await getCompanyUrlFromJob(page);
  if (!companyUrl) {
    console.log("Could not locate company URL for this job.");
    continue;
  }
  console.log(`[COMPANY] Extracted root company URL: ${companyUrl}`);
  const companySlug = extractCompanySlug(companyUrl);
  if (companySlug && isCompanyExcluded(companySlug, cfg.excludeCompanies)) {
    console.log(`[COMPANY] Skipped company slug from blocklist: ${companySlug}`);
    continue;
  }
  const companyAlreadySent = runState.companies?.[companySlug]?.sentCount || 0;
  if (companySlug && companyAlreadySent >= cfg.sentThresholdPerCompany) {
    console.log(
      `[COMPANY] Skipping ${companySlug}; already sent ${companyAlreadySent}/${cfg.sentThresholdPerCompany}`
    );
    continue;
  }

  const companyCacheKey = companySlug || extractCompanyRootUrl(companyUrl) || companyUrl;
  let memberCheck = companyMemberEligibilityCache.get(companyCacheKey);
  if (!memberCheck) {
    memberCheck = await checkCompanyMemberEligibility(page, companyUrl, cfg);
    companyMemberEligibilityCache.set(companyCacheKey, memberCheck);
  } else {
    console.log(
      `[COMPANY] Reusing cached member check for ${companyCacheKey}: ${memberCheck.reason}`
    );
  }
  if (!memberCheck.ok) {
    console.log(`[COMPANY] Skipping company by size filter: ${memberCheck.reason}`);
    continue;
  }
  if (Number.isFinite(memberCheck.memberCount)) {
    console.log(
      `[COMPANY] Eligible by size: ${memberCheck.memberCount} members (min ${cfg.minCompanyMembers})`
    );
  }

  const peopleUrl = buildCompanyPeopleUrl(companyUrl, "hiring");
  console.log(`People URL: ${peopleUrl}`);

  let count = await sendConnectionsFromPeoplePage(
    page,
    peopleUrl,
    job.title,
    job.url,
    cfg,
    runState,
    runStatePath
  );
  if (!count) {
    const fallbackUrl = buildCompanyPeopleUrl(companyUrl, "manager");
    console.log("[PEOPLE] No connectable profiles for keyword=hiring; trying keyword=manager");
    console.log(`People URL (fallback): ${fallbackUrl}`);
    count = await sendConnectionsFromPeoplePage(
      page,
      fallbackUrl,
      job.title,
      job.url,
      cfg,
      runState,
      runStatePath
    );
  }

  if (!count) {
    console.log("No connectable hiring/manager profiles found on people page.");
    console.log("[JOB] Moving to next job immediately.");
    continue;
  } else {
    runState.jobs[jobKey] = runState.jobs[jobKey] || { sentCount: 0 };
    runState.jobs[jobKey].sentCount += count;
    runState.jobs[jobKey].lastUpdatedAt = Date.now();
    if (companySlug) {
      runState.companies[companySlug] = runState.companies[companySlug] || { sentCount: 0 };
      runState.companies[companySlug].sentCount += count;
      runState.companies[companySlug].lastUpdatedAt = Date.now();
    }
    saveRunState(runStatePath, runState);
    console.log(
      `[STATE] Updated ${jobKey}: sentCount=${runState.jobs[jobKey].sentCount}/${cfg.sentThresholdPerJob}`
    );
  }

  await pauseRandom(cfg.jobDelayMinMs, cfg.jobDelayMaxMs, "between jobs");
}

console.log("\nRun complete.");
if (cfg.dryRun) {
  console.log("DRY_RUN=true: no connection requests were sent.");
}

if (cfg.keepBrowserOpen) {
  console.log("[END] KEEP_BROWSER_OPEN=true, browser left open for manual review.");
} else {
  console.log("[END] Closing browser context.");
  await context.close();
}

function splitCsv(val = "") {
  return val
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeCompanyToken(val = "") {
  return String(val).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCompanyExcluded(companyValue, blockedList = []) {
  const token = normalizeCompanyToken(companyValue);
  if (!token) return false;
  return blockedList.some((x) => normalizeCompanyToken(x) === token);
}

function firstName(full = "") {
  return full.trim().split(/\s+/)[0] || "there";
}

function buildNote(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || "");
}

function randomInt(min, max) {
  const lo = Math.max(0, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function pauseRandom(minMs, maxMs, label = "") {
  const ms = randomInt(minMs, maxMs);
  if (label) {
    console.log(`[DELAY] ${label}: ${ms}ms`);
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createGptClient(cfg) {
  if (!cfg.useGptMessage) return null;
  if (!cfg.azureOpenAIEndpoint || !cfg.azureOpenAIKey || !cfg.azureOpenAIDeployment) {
    console.log("[GPT] Missing Azure OpenAI config; using template note fallback.");
    return null;
  }
  console.log(`[GPT] Enabled with deployment=${cfg.azureOpenAIDeployment}`);
  return new OpenAI({
    baseURL: cfg.azureOpenAIEndpoint,
    apiKey: cfg.azureOpenAIKey,
  });
}

async function generateReferralNote(client, cfg, ctx) {
  if (gptDisabledForRun) return null;

  const systemPrompt =
    "Write a LinkedIn connection request for a referral. Keep it professional, natural, and at most 300 characters. Return only the final note text.";
  const userPrompt = `Candidate: ${cfg.candidateName}
Recipient first name: ${ctx.firstName}
Recipient full name: ${ctx.fullName}
Company: ${ctx.companyName || "the company"}
Job title: ${ctx.jobTitle}
Job URL: ${ctx.jobUrl}
Resume URL: ${ctx.resumeUrl}`;

  // Some Azure deployments support only one of: Responses API or Chat Completions.
  // Try Responses first, then fall back to Chat Completions.
  try {
    const response = await withTimeout(
      client.responses.create({
        model: cfg.azureOpenAIDeployment,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      cfg.gptTimeoutMs,
      "Responses API timeout"
    );
    const text = extractResponseText(response);
    if (text) return text;
    console.log("[GPT] Responses API returned no text, trying Chat Completions fallback.");
  } catch (error) {
    const msg = error?.message || String(error);
    console.log(`[GPT] Responses API failed: ${msg}`);
    if (isUnsupportedGptOperation(msg)) {
      gptDisabledForRun = true;
      console.log("[GPT] Disabling GPT personalization for this run due to unsupported Azure operation.");
      return null;
    }
  }

  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        model: cfg.azureOpenAIDeployment,
        messages: [
          { role: "developer", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      Math.min(cfg.gptTimeoutMs, 8000),
      "Chat Completions timeout"
    );
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    const msg = error?.message || String(error);
    console.log(`[GPT] Chat Completions failed: ${msg}`);
    if (isUnsupportedGptOperation(msg)) {
      gptDisabledForRun = true;
      console.log("[GPT] Disabling GPT personalization for this run due to unsupported Azure operation.");
    }
    return null;
  }
}

function isRelevant(title, include, exclude) {
  const t = sanitizeJobTitle(title).toLowerCase();
  if (exclude.some((x) => t.includes(x))) {
    return false;
  }
  if (!include.length) {
    return true;
  }
  return include.some((x) => t.includes(x));
}

async function ensureLoggedIn(page, targetJobsUrl) {
  console.log("[AUTH] Checking LinkedIn login state...");
  if (!(await isLikelyLoggedIn(page))) {
    console.log("[AUTH] No active session detected; waiting for manual login");
    const rl = readline.createInterface({ input, output });
    try {
      console.log(
        "If LinkedIn asks for login/2FA, complete it in the browser. Press Enter here when done."
      );
      await rl.question("> ");
    } finally {
      rl.close();
    }
  } else {
    console.log("[AUTH] LinkedIn session detected. Skipping manual login prompt.");
  }

  await page.goto(targetJobsUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/linkedin\.com\/jobs/, { timeout: 180000 });
  console.log(`[AUTH] Ready on jobs page: ${page.url()}`);
}

async function isLikelyLoggedIn(page) {
  const hasLoginForm =
    (await page.locator("input[name='session_key']").first().isVisible().catch(() => false)) ||
    (await page.locator("form[action*='login']").first().isVisible().catch(() => false)) ||
    (await page.getByRole("button", { name: /sign in/i }).first().isVisible().catch(() => false));

  if (hasLoginForm) return false;

  const hasAppNav =
    (await page.locator("a[href='/feed/'], a[href='/jobs/']").first().isVisible().catch(() => false)) ||
    (await page.locator("img.global-nav__me-photo, button[aria-label*='Me']").first().isVisible().catch(() => false));

  return hasAppNav;
}

async function collectJobs(page, maxJobs) {
  console.log("[JOBS] Collecting job cards...");
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "jobs initial wait");
  await page.locator("a[href*='/jobs/view/']").first().waitFor({ timeout: 15000 }).catch(() => {});

  const aggregated = [];

  if (cfg.useStartPagination) {
    const baseUrl = stripStartParam(page.url());
    const maxStartPages = Math.max(1, Math.ceil(maxJobs / Math.max(1, cfg.jobsPageSize)) + 3);
    for (let pageIndex = 0; pageIndex < maxStartPages && aggregated.length < maxJobs; pageIndex++) {
      const start = pageIndex * Math.max(1, cfg.jobsPageSize);
      const pageUrl = buildJobsUrlWithStart(baseUrl, start);
      console.log(`[JOBS] Loading search page via start=${start}`);
      if (normalizeUrlNoHash(page.url()) !== normalizeUrlNoHash(pageUrl)) {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, `after jobs start=${start}`);
      }

      const jobsOnPage = await extractJobsFromCurrentPage(page);
      const merged = uniqueBy([...aggregated, ...jobsOnPage], (x) => x.url);
      aggregated.length = 0;
      aggregated.push(...merged);
      console.log(
        `[JOBS] start=${start} page=${pageIndex + 1}: collected ${aggregated.length}/${maxJobs}`
      );

      if (!jobsOnPage.length) {
        console.log("[JOBS] No jobs found on this start page; stopping start pagination.");
        break;
      }
    }

    console.log(`[JOBS] Raw jobs found via start pagination: ${aggregated.length}`);
    return aggregated.slice(0, maxJobs);
  }

  let previousCount = 0;
  let stagnantRounds = 0;
  const maxRounds = 20;
  let paginationAdvances = 0;
  const maxPaginationAdvances = 3;

  for (let round = 1; round <= maxRounds; round++) {
    const jobsOnPage = await extractJobsFromCurrentPage(page);

    const merged = uniqueBy([...aggregated, ...jobsOnPage], (x) => x.url);
    aggregated.length = 0;
    aggregated.push(...merged);
    console.log(`[JOBS] Round ${round}: collected ${aggregated.length}/${maxJobs}`);

    if (aggregated.length >= maxJobs) break;
    if (aggregated.length <= previousCount) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
      previousCount = aggregated.length;
    }
    if (stagnantRounds >= 3) {
      const pagination = await getJobsPaginationState(page);
      if (pagination) {
        console.log(`[JOBS] Pagination state: page ${pagination.current} of ${pagination.total}`);
      }
      const moved = await goToNextJobsPage(page, cfg);
      if (moved && paginationAdvances < maxPaginationAdvances) {
        paginationAdvances += 1;
        console.log(`[JOBS] Moved to next jobs page (${paginationAdvances}/${maxPaginationAdvances})`);
        stagnantRounds = 0;
        previousCount = aggregated.length;
        await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after jobs next page");
        continue;
      }
      console.log("[JOBS] No new jobs loading after repeated scroll attempts.");
      break;
    }

    // Scroll the jobs list pane (left rail) when available; fallback to page scroll.
    await scrollJobsResults(page, cfg, round);

    // Some layouts use a "Show more jobs/results" control.
    const showMoreJobs = page
      .locator(
        "button:has-text('Show more jobs'), button:has-text('See more jobs'), button:has-text('Show more results'), a:has-text('Show more jobs')"
      )
      .first();
    if (await showMoreJobs.isVisible().catch(() => false)) {
      console.log("[JOBS] Clicking show-more control for additional jobs...");
      await showMoreJobs.click().catch(() => {});
      await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after jobs show-more");
    }
  }

  console.log(`[JOBS] Raw jobs found on page: ${aggregated.length}`);
  return aggregated.slice(0, maxJobs);
}

async function extractJobsFromCurrentPage(page) {
  return await page.evaluate(() => {
    const listRoot =
      document.querySelector(".scaffold-layout__list") ||
      document.querySelector(".jobs-search-results-list") ||
      document;
    const strictSelectors = [
      ".scaffold-layout__list-item a[href*='/jobs/view/']",
      ".jobs-search-results__list-item a[href*='/jobs/view/']",
    ];
    const strictAnchors = Array.from(listRoot.querySelectorAll(strictSelectors.join(", ")));
    const anchors =
      strictAnchors.length > 0
        ? strictAnchors
        : Array.from(listRoot.querySelectorAll("a[href*='/jobs/view/']"));
    const out = [];

    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      const url = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
      const title = (a.textContent || "").trim().replace(/\s+/g, " ");
      if (!title) continue;

      const row =
        a.closest("li, .job-card-container, .jobs-search-results__list-item, .artdeco-card") ||
        a.parentElement;
      const companyEl = row?.querySelector(
        ".job-card-container__company-name, .artdeco-entity-lockup__subtitle, .job-card-container__primary-description"
      );
      const company = (companyEl?.textContent || "").trim().replace(/\s+/g, " ");

      out.push({ title, company, url: url.split("?")[0] });
    }
    return out;
  });
}

async function openJob(page, url) {
  console.log(`[NAV] Opening job detail: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "job detail load");
  console.log(`[NAV] Job page loaded: ${page.url()}`);
}

async function checkExperienceMatch(page, cfg) {
  if (!cfg.experienceFilterEnabled) {
    return { ok: true, reason: "disabled" };
  }

  const desc = await getJobDescriptionText(page);
  if (!desc) {
    return { ok: true, reason: "job description unavailable (allowing)" };
  }

  const requirement = extractExperienceRequirement(desc);
  if (!requirement) {
    return { ok: true, reason: "experience requirement not detected (allowing)" };
  }

  const effectiveYears = cfg.candidateYears + cfg.internshipYears * cfg.internshipWeight;
  const minReq = requirement.minYears;
  const withinBand = minReq >= cfg.preferredMinYears && minReq <= cfg.preferredMaxYears;
  const overCandidate = minReq > effectiveYears + 1;

  if (!withinBand || overCandidate) {
    return {
      ok: false,
      reason: `required min=${minReq}y (target ${cfg.preferredMinYears}-${cfg.preferredMaxYears}y, effective profile ${effectiveYears.toFixed(1)}y)`,
    };
  }

  console.log(
    `[JOB] Experience match: detected min=${minReq}y, range=${requirement.rangeLabel} (target ${cfg.preferredMinYears}-${cfg.preferredMaxYears}y)`
  );
  return { ok: true, reason: "matched" };
}

async function getJobDescriptionText(page) {
  const selectors = [
    ".jobs-description__content",
    ".jobs-box__html-content",
    "#job-details",
    ".jobs-description-content__text",
    "[data-test-job-description]",
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      const text = (await loc.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return "";
}

function extractExperienceRequirement(text = "") {
  const t = String(text).toLowerCase();
  const patterns = [
    /(\d{1,2})\s*(?:\+)?\s*[-–to]+\s*(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?)/g,
    /(\d{1,2})\s*(?:to)\s*(\d{1,2})\s*(?:years?|yrs?)/g,
    /at least\s+(\d{1,2})\s*(?:years?|yrs?)/g,
    /minimum(?: of)?\s+(\d{1,2})\s*(?:years?|yrs?)/g,
    /(\d{1,2})\s*\+\s*(?:years?|yrs?)/g,
    /(\d{1,2})\s*(?:years?|yrs?)\s+of\s+experience/g,
    /(\d{1,2})\s*(?:years?|yrs?)\s+experience/g,
  ];

  let best = null;

  for (const p of patterns) {
    p.lastIndex = 0;
    let m;
    while ((m = p.exec(t)) !== null) {
      let minYears = Number(m[1]);
      let maxYears = Number(m[2] || m[1]);
      if (!Number.isFinite(minYears) || minYears <= 0) continue;
      if (!Number.isFinite(maxYears) || maxYears <= 0) maxYears = minYears;
      if (maxYears < minYears) {
        const tmp = minYears;
        minYears = maxYears;
        maxYears = tmp;
      }
      if (minYears > 25) continue;

      const score = minYears * 100 + maxYears;
      if (!best || score > best.score) {
        best = {
          minYears,
          maxYears,
          rangeLabel: `${minYears}-${maxYears}y`,
          score,
        };
      }
    }
  }

  return best
    ? {
        minYears: best.minYears,
        maxYears: best.maxYears,
        rangeLabel: best.rangeLabel,
      }
    : null;
}

async function getCompanyUrlFromJob(page) {
  console.log("[COMPANY] Searching company link on job page...");
  const companyLink = page
    .locator("a[href*='/company/']:not([href*='/jobs/']):not([href*='miniCompany'])")
    .first();
  if (!(await companyLink.isVisible().catch(() => false))) return null;
  const href = await companyLink.getAttribute("href");
  console.log(`[COMPANY] Found company href: ${href || "N/A"}`);
  if (!href) return null;
  return extractCompanyRootUrl(normalizeLinkedInUrl(href));
}

function buildCompanyPeopleUrl(companyUrl, keyword) {
  const base = extractCompanyRootUrl(companyUrl) || companyUrl.replace(/\/+$/, "");
  return `${base}/people/?keywords=${encodeURIComponent(keyword)}`;
}

async function sendConnectionsFromPeoplePage(
  page,
  peopleUrl,
  jobTitle,
  jobUrl,
  cfg,
  runState,
  runStatePath
) {
  console.log(`[PEOPLE] Opening people page: ${peopleUrl}`);
  await page.goto(peopleUrl, { waitUntil: "domcontentloaded" });
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "people page load");
  console.log(`[PEOPLE] Landed on: ${page.url()}`);

  let processed = 0;
  let sent = 0;
  const maxScan = 35;
  let loops = 0;
  const maxLoops = 12;
  const companySlug = extractCompanySlug(peopleUrl);
  const cleanJobTitle = compactJobTitle(jobTitle, 64);
  const seenCandidateKeys = new Set();
  let prevCardCount = -1;
  let stagnantLoops = 0;

  while (processed < maxScan && sent < cfg.maxContactsPerJob && loops < maxLoops) {
    loops += 1;
    console.log(
      `[PEOPLE] Loop ${loops}: processed=${processed}, sent=${sent}, target=${cfg.maxContactsPerJob}`
    );
    const cards = page.locator("li, .artdeco-card, .discover-person-card");
    const cardCount = await cards.count();
    console.log(`[PEOPLE] Visible cards in DOM: ${cardCount}`);
    if (cardCount <= prevCardCount) {
      stagnantLoops += 1;
    } else {
      stagnantLoops = 0;
      prevCardCount = cardCount;
    }
    let anyConnectVisibleThisLoop = false;

    for (let i = 0; i < cardCount && sent < cfg.maxContactsPerJob; i++) {
      if (processed >= maxScan) break;
      const card = cards.nth(i);

      const connectBtn = getConnectButton(card);
      if (!(await connectBtn.isVisible().catch(() => false))) {
        continue;
      }
      anyConnectVisibleThisLoop = true;

      processed += 1;
      const candidate = await extractCandidateFromCard(card, companySlug);
      const name = candidate.name;
      const candidateKey = deriveCandidateKey(candidate, companySlug);
      if (candidateKey && seenCandidateKeys.has(candidateKey)) {
        console.log(`[PEOPLE] Candidate #${processed}: ${name} (already seen in this scan, skipping)`);
        continue;
      }
      if (candidateKey) {
        seenCandidateKeys.add(candidateKey);
      }

      const prior = candidateKey ? runState.contacts?.[candidateKey] : null;
      if (prior?.sentAt) {
        console.log(`[PEOPLE] Candidate #${processed}: ${name} (already contacted, skipping)`);
        continue;
      }
      if (prior?.blockedReason === "email_verification") {
        console.log(
          `[PEOPLE] Candidate #${processed}: ${name} (blocked earlier: email verification, skipping)`
        );
        continue;
      }
      console.log(`[PEOPLE] Candidate #${processed}: ${name}`);
      let note = buildNote(cfg.noteTemplate, {
        FirstName: firstName(name),
        JobTitle: cleanJobTitle,
        ResumeUrl: cfg.resumeUrl,
        JobUrl: jobUrl,
        Signature: getCandidateSignature(cfg),
        CandidateName: cfg.candidateName,
      });
      if (cfg.useGptMessage && gptClient) {
        const generated = await generateReferralNote(gptClient, cfg, {
          firstName: firstName(name),
          fullName: name,
          jobTitle: sanitizeJobTitle(jobTitle),
          jobUrl,
          companyName: extractCompanyNameFromPeopleUrl(peopleUrl),
          resumeUrl: cfg.resumeUrl,
        });
        if (generated) {
          note = generated;
          console.log(`[GPT] Generated personalized note (${note.length} chars)`);
        }
      }

      const safeNote = fitNoteWithinLimit(note, cfg.maxNoteChars, {
        FirstName: firstName(name),
        ResumeUrl: cfg.resumeUrl,
        JobUrl: jobUrl,
        JobTitle: cleanJobTitle,
        Signature: getCandidateSignature(cfg),
        CandidateName: cfg.candidateName,
      });
      if (!safeNote) {
        console.log(`Skipping ${name}; unable to build note within ${cfg.maxNoteChars} chars.`);
        continue;
      }
      if (safeNote.length !== note.length) {
        console.log(`[NOTE] Trimmed note for ${name}: ${note.length} -> ${safeNote.length}`);
      }

      console.log(`Connect target: ${name}`);
      const result = await sendConnectionFromCard(page, card, safeNote, cfg.dryRun, cfg);
      if (result.ok) {
        sent += 1;
        if (candidateKey) {
          runState.contacts[candidateKey] = {
            name: candidate.name,
            profileUrl: candidate.profileUrl,
            companySlug,
            sentAt: Date.now(),
            blockedReason: "",
            lastAttemptAt: Date.now(),
          };
          saveRunState(runStatePath, runState);
        }
      } else if (candidateKey) {
        const prev = runState.contacts[candidateKey] || {};
        runState.contacts[candidateKey] = {
          ...prev,
          name: candidate.name || prev.name || "",
          profileUrl: candidate.profileUrl || prev.profileUrl || "",
          companySlug: companySlug || prev.companySlug || "",
          lastAttemptAt: Date.now(),
          blockedReason: result.reason === "email_verification" ? "email_verification" : "",
        };
        saveRunState(runStatePath, runState);
      }
      console.log(
        `[PEOPLE] Result for ${name}: ${result.ok ? "SUCCESS" : `FAILED/SKIPPED${result.reason ? ` (${result.reason})` : ""}`}`
      );
      await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "between candidates");
    }

    if (sent >= cfg.maxContactsPerJob || processed >= maxScan) break;
    if (!anyConnectVisibleThisLoop) {
      console.log("[PEOPLE] No visible connect buttons in this viewport.");
      const expanded = await clickShowMoreResults(page, cfg);
      if (expanded) {
        continue;
      }
    }
    if (stagnantLoops >= 3) {
      console.log("[PEOPLE] No new candidates loading after repeated attempts. Stopping early.");
      break;
    }
    console.log("[PEOPLE] Scrolling for more candidates...");
    await page.mouse.wheel(0, 1400);
    await pauseRandom(cfg.scrollDelayMinMs, cfg.scrollDelayMaxMs, "people scroll");
  }

  console.log(`Processed ${processed} candidates, completed ${sent} connect actions.`);
  return sent;
}

async function extractCandidateFromCard(card, companySlug = "") {
  const inviteFromButton = await card
    .locator("button[aria-label*='Invite']")
    .first()
    .getAttribute("aria-label")
    .catch(() => null);
  let nameFromInvite = "";
  if (inviteFromButton) {
    const m = inviteFromButton.match(/invite\s+(.+?)\s+to\s+connect/i);
    if (m?.[1]) nameFromInvite = cleanName(m[1]);
  }

  const profileLink = card.locator("a[href*='/in/']").first();
  const profileHrefRaw = await profileLink.getAttribute("href").catch(() => null);
  const profileUrl = profileHrefRaw ? normalizeLinkedInUrl(profileHrefRaw) : "";
  const linkText = (await profileLink.innerText().catch(() => "")).trim();
  if (linkText) {
    return {
      name: cleanName(linkText),
      profileUrl,
      key: makeContactKey(profileUrl, cleanName(linkText), companySlug),
    };
  }

  if (nameFromInvite) {
    return {
      name: nameFromInvite,
      profileUrl,
      key: makeContactKey(profileUrl, nameFromInvite, companySlug),
    };
  }

  const titleText = (
    await card
      .locator(".artdeco-entity-lockup__title, .discover-person-card__name, h3, h4")
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
  if (titleText) {
    const clean = cleanName(titleText);
    return {
      name: clean,
      profileUrl,
      key: makeContactKey(profileUrl, clean, companySlug),
    };
  }

  return {
    name: "there",
    profileUrl,
    key: makeContactKey(profileUrl, "there", companySlug),
  };
}

async function sendConnectionFromCard(page, card, note, dryRun, cfg) {
  const connectBtn = getConnectButton(card);
  if (!(await connectBtn.isVisible().catch(() => false))) {
    return { ok: false, reason: "connect_not_visible" };
  }

  console.log("[ACTION] Clicking Connect");
  await connectBtn.click().catch(() => {});
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after connect click");

  const modal = page.locator(".artdeco-modal, [role='dialog']").last();
  const addNoteBtn = modal
    .getByRole("button", { name: /add a note|add note/i })
    .first();
  if (await addNoteBtn.isVisible().catch(() => false)) {
    console.log("[ACTION] Clicking Add a note");
    await addNoteBtn.click().catch(() => {});
    await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after add note click");
  } else {
    console.log("[ACTION] Add a note button not shown");
  }

  if (await requiresEmailVerification(modal)) {
    console.log("[ACTION] Email verification required for this profile. Skipping.");
    await closeDialog(page);
    return { ok: false, reason: "email_verification" };
  }

  const noteInput = page
    .locator(
      ".artdeco-modal textarea[name='message'], .artdeco-modal textarea#custom-message, [role='dialog'] textarea[name='message'], [role='dialog'] textarea#custom-message, textarea[name='message'], textarea#custom-message"
    )
    .first();
  if (!(await noteInput.isVisible().catch(() => false))) {
    console.log("Could not open note input. Closing dialog.");
    await closeDialog(page);
    return { ok: false, reason: "note_input_missing" };
  }

  console.log(`[ACTION] Filling note (${note.length} chars)`);
  await noteInput.fill(note);
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after note fill");

  if (dryRun) {
    console.log("[ACTION] DRY_RUN: note prepared (not sent).");
    await closeDialog(page);
    return { ok: true, reason: "dry_run" };
  }

  const sendBtn = modal
    .locator(
      "button:has-text('Send'), button:has-text('Send now'), button[aria-label*='Send invitation'], button[aria-label*='Send now']"
    )
    .first();
  if (await sendBtn.isVisible().catch(() => false)) {
    if (await requiresEmailVerification(modal)) {
      console.log("[ACTION] Send blocked by email verification. Skipping.");
      await closeDialog(page);
      return { ok: false, reason: "email_verification" };
    }
    if (await sendBtn.isDisabled().catch(() => false)) {
      console.log("[ACTION] Send button is disabled. Skipping.");
      await closeDialog(page);
      return { ok: false, reason: "send_disabled" };
    }
    const sendLabel =
      (await sendBtn.innerText().catch(() => "")) ||
      (await sendBtn.getAttribute("aria-label").catch(() => "")) ||
      "Send";
    console.log(`[ACTION] Clicking ${sendLabel.trim()}`);
    await sendBtn.click().catch(() => {});
    await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after send click");
    console.log("Connection request sent.");
    return { ok: true, reason: "sent" };
  }

  console.log("[ACTION] Send button not found.");
  await closeDialog(page);
  return { ok: false, reason: "send_not_found" };
}

async function requiresEmailVerification(modal) {
  const emailInput = modal
    .locator("input[type='email'], input[name*='email' i], input[placeholder*='email' i]")
    .first();
  if (await emailInput.isVisible().catch(() => false)) return true;

  const gateText = modal
    .locator(":scope")
    .filter({ hasText: /enter their email to connect|verify this member knows you/i })
    .first();
  return await gateText.isVisible().catch(() => false);
}

function getConnectButton(scope) {
  return scope
    .locator(
      "button:has-text('Connect'), button[aria-label*='Invite'][aria-label*='connect'], button[aria-label*='connect']"
    )
    .first();
}

async function closeDialog(page) {
  console.log("[ACTION] Closing dialog");
  const dismiss = page.getByRole("button", { name: /dismiss|cancel|close/i }).first();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function clickShowMoreResults(page, cfg) {
  const btn = page
    .locator(
      "button:has-text('Show more results'), a:has-text('Show more results'), div[role='button']:has-text('Show more results')"
    )
    .first();
  if (!(await btn.isVisible().catch(() => false))) {
    return false;
  }
  console.log("[PEOPLE] Clicking Show more results...");
  await btn.click().catch(() => {});
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after show more results");
  return true;
}

async function scrollJobsResults(page, cfg, round) {
  const result = await page.evaluate(() => {
    const preferredPane =
      document.querySelector(".scaffold-layout__list") ||
      document.querySelector(".jobs-search-results-list");
    if (preferredPane && preferredPane.scrollHeight - preferredPane.clientHeight > 120) {
      const prev = preferredPane.scrollTop;
      preferredPane.scrollTop = Math.min(preferredPane.scrollTop + 2200, preferredPane.scrollHeight);
      if (preferredPane.scrollTop !== prev) return "pane";
    }

    const anchors = Array.from(
      document.querySelectorAll(".scaffold-layout__list-item a[href*='/jobs/view/'], a[href*='/jobs/view/']")
    ).filter((a) => a.offsetParent !== null);
    if (!anchors.length) return "page";

    const lastAnchor = anchors[anchors.length - 1];
    const row =
      lastAnchor.closest("li, .job-card-container, .jobs-search-results__list-item, .artdeco-card") ||
      lastAnchor;
    row.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });

    // Walk up from last card and scroll the first genuinely scrollable ancestor.
    let el = row.parentElement;
    while (el) {
      const canScroll = el.scrollHeight - el.clientHeight > 120;
      if (canScroll) {
        const prev = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + 2200, el.scrollHeight);
        if (el.scrollTop !== prev) return "pane";
      }
      el = el.parentElement;
    }

    return "page";
  });

  if (result === "pane") {
    console.log(`[JOBS] Scrolled jobs list pane via card-ancestor (round ${round})`);
  } else {
    console.log(`[JOBS] Pane scroll unavailable, using page scroll (round ${round})`);
    await page.mouse.wheel(0, 2400);
  }
  await pauseRandom(cfg.scrollDelayMinMs, cfg.scrollDelayMaxMs, `jobs scroll round ${round}`);
}

async function goToNextJobsPage(page, cfg) {
  const before = await getJobsPaginationState(page);
  const nextBtn = page
    .locator(
      "button.jobs-search-pagination__button--next:not([disabled]), button[aria-label*='View next page']:not([disabled])"
    )
    .first();
  if (!(await nextBtn.isVisible().catch(() => false))) return false;

  console.log("[JOBS] Clicking pagination Next...");
  await nextBtn.click().catch(() => {});
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "after jobs pagination next");
  if (before) {
    await page
      .waitForFunction(
        ({ expected }) => {
          const root = document.querySelector(".jobs-search-pagination");
          if (!root) return false;
          const text = (root.textContent || "").replace(/\s+/g, " ");
          const m = text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
          return Boolean(m && Number(m[1]) !== expected);
        },
        { expected: before.current },
        { timeout: 12000 }
      )
      .catch(() => {});
  }
  await page
    .locator(".scaffold-layout__list-item a[href*='/jobs/view/'], .jobs-search-results__list-item a[href*='/jobs/view/']")
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  return true;
}

function normalizeLinkedInUrl(href) {
  if (href.startsWith("http")) return href.split("?")[0];
  return `https://www.linkedin.com${href}`.split("?")[0];
}

function stripStartParam(rawUrl = "") {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("start");
    return u.toString();
  } catch {
    return String(rawUrl).replace(/([?&])start=\d+(&|$)/, "$1").replace(/[?&]$/, "");
  }
}

function buildJobsUrlWithStart(baseUrl, start) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("start", String(Math.max(0, Number(start) || 0)));
    return u.toString();
  } catch {
    const sep = String(baseUrl).includes("?") ? "&" : "?";
    return `${baseUrl}${sep}start=${Math.max(0, Number(start) || 0)}`;
  }
}

function normalizeUrlNoHash(rawUrl = "") {
  return String(rawUrl || "").split("#")[0];
}

function cleanName(text = "") {
  return text.replace(/\s+/g, " ").split(" · ")[0].trim();
}

function compactJobTitle(title = "", maxLen = 64) {
  const t = sanitizeJobTitle(title);
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

function sanitizeJobTitle(title = "") {
  let t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return "";

  t = t
    .replace(/\bwith verification\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Remove duplicated contiguous phrases like:
  // "Senior Staff Engineer (FE) Senior Staff Engineer (FE)"
  const words = t.split(" ").filter(Boolean);
  const n = words.length;
  for (let size = Math.floor(n / 2); size >= 2; size--) {
    const first = words.slice(0, size).join(" ").toLowerCase();
    const second = words.slice(size, size * 2).join(" ").toLowerCase();
    if (first && first === second) {
      t = words.slice(0, size).concat(words.slice(size * 2)).join(" ");
      break;
    }
  }

  // Remove immediate duplicated tokens.
  t = t.replace(/\b(\w+)\s+\1\b/gi, "$1").replace(/\s+/g, " ").trim();
  return t;
}

function fallbackShortNote({ FirstName, JobTitle, ResumeUrl, JobUrl, Signature }) {
  return `Hi ${FirstName},

I came across the ${JobTitle} role and it looks like a strong fit for my background.
Resume: ${ResumeUrl}
Job: ${JobUrl}

Thanks for considering,
${Signature || "Candidate"}`;
}

function fitNoteWithinLimit(note, maxChars, vars) {
  let n = normalizeNoteText(String(note || ""));
  if (n.length <= maxChars) return n;

  n = normalizeNoteText(
    n
    .replace("Would you kindly consider referring me for this position?", "Would you consider referring me?")
    .replace("Thank you for your assistance.", "Thanks.")
    .replace("Best regards,", "")
    .replace("Dhruv Rana", vars.CandidateName || "Candidate")
  );
  if (n.length <= maxChars) return n;

  const medium = `Hi ${vars.FirstName},
I found the ${vars.JobTitle} role and it seems aligned with my experience.
Resume: ${vars.ResumeUrl}
Job: ${vars.JobUrl}
Thanks,
${vars.Signature || "Candidate"}`;
  const mediumClean = normalizeNoteText(medium);
  if (mediumClean.length <= maxChars) return mediumClean;

  const short = normalizeNoteText(
    `Hi ${vars.FirstName},
I found a relevant role at your company. If my profile looks fit, could you refer me?
Resume: ${vars.ResumeUrl}
Job: ${vars.JobUrl}
Thanks - ${vars.Signature || "Candidate"}`
  );
  if (short.length <= maxChars) return short;

  const ultraShort = normalizeNoteText(
    `Hi ${vars.FirstName}, could you please consider a referral if my profile is relevant?
Resume: ${vars.ResumeUrl}
Job: ${vars.JobUrl}
Thanks - ${vars.Signature || "Candidate"}`
  );
  if (ultraShort.length <= maxChars) return ultraShort;

  if (maxChars < 40) return null;
  return `${short.slice(0, maxChars - 1).trim()}…`;
}

function normalizeNoteText(text = "") {
  const normalizedLines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  // Collapse excessive blank lines while preserving paragraph formatting.
  const compact = [];
  let prevBlank = false;
  for (const line of normalizedLines) {
    const isBlank = line.length === 0;
    if (isBlank && prevBlank) continue;
    compact.push(line);
    prevBlank = isBlank;
  }
  return compact.join("\n").trim();
}

function extractCompanyRootUrl(url) {
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/company/${m[1]}`;
}

function extractCompanySlug(url = "") {
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m?.[1] || "";
}

function extractCompanyNameFromPeopleUrl(url = "") {
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!m?.[1]) return "";
  return m[1].replace(/-/g, " ");
}

async function checkCompanyMemberEligibility(page, companyUrl, cfg) {
  const companyRootUrl = extractCompanyRootUrl(companyUrl);
  if (!companyRootUrl) {
    return { ok: false, reason: "company URL could not be parsed", memberCount: null };
  }

  const peopleOverviewUrl = `${companyRootUrl}/people/`;
  console.log(`[COMPANY] Checking member count on: ${peopleOverviewUrl}`);

  await page.goto(peopleOverviewUrl, { waitUntil: "domcontentloaded" });
  await pauseRandom(cfg.actionDelayMinMs, cfg.actionDelayMaxMs, "company people overview load");

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const memberCount = extractCompanyMemberCount(bodyText);
  if (!Number.isFinite(memberCount)) {
    return {
      ok: false,
      reason: "unable to detect company member count",
      memberCount: null,
    };
  }

  if (memberCount < cfg.minCompanyMembers) {
    return {
      ok: false,
      reason: `member count ${memberCount} is below minimum ${cfg.minCompanyMembers}`,
      memberCount,
    };
  }

  return {
    ok: true,
    reason: `member count ${memberCount} meets minimum ${cfg.minCompanyMembers}`,
    memberCount,
  };
}

function extractCompanyMemberCount(text = "") {
  const raw = String(text || "").toLowerCase();
  const patterns = [
    /([\d,.]+\s*[kmb]?)\s*(?:associated\s+)?members\b/g,
    /([\d,.]+\s*[kmb]?)\s*(?:on\s+linkedin\s+)?members\b/g,
    /([\d,.]+\s*[kmb]?)\s*employees\b/g,
  ];

  let best = null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      const parsed = parseCompactNumber(match[1]);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      if (!best || parsed > best) {
        best = parsed;
      }
    }
  }

  return best;
}

function parseCompactNumber(input = "") {
  const compact = String(input || "").trim().toLowerCase().replace(/,/g, "");
  if (!compact) return NaN;
  const match = compact.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return NaN;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return NaN;

  const suffix = (match[2] || "").toLowerCase();
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const multiplier = suffix ? multipliers[suffix] || 1 : 1;
  return Math.round(base * multiplier);
}

function makeContactKey(profileUrl = "", name = "", companySlug = "") {
  if (profileUrl) return profileUrl.toLowerCase();
  const n = normalizeCompanyToken(name);
  const c = normalizeCompanyToken(companySlug);
  if (!n) return "";
  if (c) return `${c}:${n}`;
  return `global:${n}`;
}

function deriveCandidateKey(candidate, companySlug = "") {
  if (candidate?.key) return candidate.key;
  const byCompanyAndName = makeContactKey("", candidate?.name || "", companySlug);
  if (byCompanyAndName) return byCompanyAndName;
  return makeContactKey("", candidate?.name || "", "");
}

function extractResponseText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  if (Array.isArray(response.output)) {
    const parts = [];
    for (const item of response.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        const text = c?.text;
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

async function getJobsPaginationState(page) {
  return await page.evaluate(() => {
    const root = document.querySelector(".jobs-search-pagination");
    if (!root) return null;
    const text = (root.textContent || "").replace(/\s+/g, " ");
    const m = text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { current: Number(m[1]), total: Number(m[2]) };
  });
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const k = keyFn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function withTimeout(promise, timeoutMs, label = "Operation timeout") {
  const safeMs = Math.max(1000, Number(timeoutMs) || 10000);
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} after ${safeMs}ms`)), safeMs)
    ),
  ]);
}

function getCandidateSignature(cfg) {
  if (cfg?.candidateSignature && String(cfg.candidateSignature).trim()) {
    return String(cfg.candidateSignature).trim();
  }
  return firstName(cfg?.candidateName || "Candidate");
}

function isUnsupportedGptOperation(message = "") {
  const m = String(message).toLowerCase();
  return (
    m.includes("requested operation is unsupported") ||
    m.includes("unsupported parameter") ||
    m.includes("operation is unsupported")
  );
}

function getJobKey(jobUrl = "") {
  const m = String(jobUrl).match(/\/jobs\/view\/(\d+)/);
  if (m) return m[1];
  return String(jobUrl).split("?")[0];
}

function loadRunState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { jobs: {}, companies: {}, contacts: {} };
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { jobs: {}, companies: {}, contacts: {} };
    if (!parsed.jobs || typeof parsed.jobs !== "object") parsed.jobs = {};
    if (!parsed.companies || typeof parsed.companies !== "object") parsed.companies = {};
    if (!parsed.contacts || typeof parsed.contacts !== "object") parsed.contacts = {};
    return parsed;
  } catch {
    return { jobs: {}, companies: {}, contacts: {} };
  }
}

function saveRunState(filePath, state) {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
