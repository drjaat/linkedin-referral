import { DEFAULTS, migrateSettings, csv, jobKey, isPostUrl, postKey, companyRoot, companySlug, jobMatches, experienceMatches, parseMemberCount, makeNote, makePostNote } from "./core.js";

const fields = Object.keys(DEFAULTS);
const numeric = new Set(["maxContacts", "maxPerCompany", "minCompanyMembers", "minYears", "maxYears", "candidateYears", "internshipYears", "internshipWeight"]);
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let busy = false;
let review = null;

const saved = await chrome.storage.local.get(["settings"]);
const initial = { ...DEFAULTS, ...migrateSettings(saved.settings || {}) };
for (const key of fields) {
  const input = $(key);
  if (typeof DEFAULTS[key] === "boolean") input.checked = Boolean(initial[key]);
  else {
    if (key === "minCompanyMembers" && ![...input.options].some(option => option.value === String(initial[key]))) {
      input.add(new Option(`${Number(initial[key]).toLocaleString()}+ members`, String(initial[key])));
    }
    input.value = initial[key];
  }
}

function settingsFromForm() {
  return Object.fromEntries(fields.map(key => {
    const input = $(key);
    return [key, typeof DEFAULTS[key] === "boolean" ? input.checked : numeric.has(key) ? Number(input.value) : input.value.trim()];
  }));
}

function validate(settings, source) {
  if (!settings.candidateName) throw new Error("Enter your name.");
  if (source === "job" && (!settings.resumeUrl || !settings.noteTemplate)) throw new Error("Enter your resume URL and job note template.");
  if (source === "post" && !settings.postNoteTemplate) throw new Error("Enter a post engagement note template.");
  if (settings.resumeUrl && new URL(settings.resumeUrl).protocol !== "https:") throw new Error("Resume URL must use HTTPS.");
  for (const key of numeric) if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`Enter a valid value for ${key}.`);
  if (!settings.maxContacts || !settings.maxPerCompany) throw new Error("Request limits must be at least one.");
  if (settings.maxContacts > 20 || settings.maxPerCompany > 20) throw new Error("Request limits cannot exceed 20.");
  if (settings.minYears > settings.maxYears) throw new Error("Minimum experience cannot exceed maximum.");
  if (settings.internshipWeight > 1) throw new Error("Internship weight cannot exceed one.");
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  $("log").append(item);
  $("status").textContent = message;
}

function updateActions() {
  $("preview").disabled = busy;
  $("send").disabled = busy || !review || ![...$("results").querySelectorAll("input[data-review-index]")].some(input => input.checked);
  $("clearHistory").disabled = busy;
  for (const key of fields) $(key).disabled = busy;
}

function renderPerson(person, note, label, index) {
  const box = document.createElement("div");
  box.className = "person";
  const heading = document.createElement("strong");
  heading.textContent = person.name;
  const status = document.createElement("small");
  status.textContent = `${person.role} · ${label}`;
  const profile = document.createElement("a");
  profile.href = person.profileUrl;
  profile.target = "_blank";
  profile.rel = "noopener";
  profile.textContent = person.profileUrl;
  const preview = document.createElement("pre");
  preview.textContent = note;
  if (Number.isInteger(index)) {
    const choice = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.reviewIndex = String(index);
    input.setAttribute("aria-label", `Send this reviewed note to ${person.name}`);
    input.addEventListener("change", updateActions);
    choice.append(input, heading);
    box.append(choice);
  } else box.append(heading);
  box.append(status, profile, preview);
  $("results").append(box);
  return box;
}

async function message(tabId, type, payload) {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type, payload });
      if (!response?.ok) throw new Error(response?.error || "LinkedIn page did not respond.");
      return response.result;
    } catch (error) {
      lastError = error;
      if (!/receiving end|could not establish|message port closed/i.test(error.message)) throw error;
      if (attempt === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch (injectionError) {
          throw new Error(`Could not connect to this LinkedIn tab: ${injectionError.message}`);
        }
      }
      await sleep(350);
    }
  }
  throw lastError;
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  for (let attempt = 0; attempt < 40; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url?.startsWith(url.split("?")[0])) {
      await message(tabId, "ping");
      await sleep(550);
      return;
    }
    await sleep(250);
  }
  throw new Error(`LinkedIn page did not finish loading: ${url}`);
}

function contactKey(person, slug) {
  return person.profileUrl || `${slug}:${person.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

async function collectPeople(tabId, url) {
  await navigate(tabId, url);
  const found = new Map();
  for (let round = 0; round < 5 && found.size < 35; round++) {
    const people = await message(tabId, "listCandidates");
    for (const person of people) found.set(person.key, person);
    if (round < 4) await message(tabId, "showMore");
  }
  return [...found.values()].slice(0, 35);
}

async function revealPerson(tabId, key) {
  for (let round = 0; round < 7; round++) {
    if ((await message(tabId, "listCandidates")).some(person => person.key === key)) return true;
    if (round < 6) await message(tabId, "showMore");
  }
  return false;
}

async function findContacts() {
  if (busy) return;
  busy = true;
  review = null;
  updateActions();
  $("log").replaceChildren();
  $("results").replaceChildren();
  let tabId, originalUrl;
  let restoreTab = false;
  try {
    const settings = settingsFromForm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const source = /^https:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/\d+/.test(tab?.url || "") ? "job"
      : isPostUrl(tab?.url || "") ? "post" : "";
    if (!tab?.id || !source) throw new Error("Open a LinkedIn job detail page or a specific post link first.");
    validate(settings, source);
    await chrome.storage.local.set({ settings });
    tabId = tab.id;
    originalUrl = tab.url;
    if (source === "post") {
      log("Finding commenters and people who reacted to this post.");
      const state = (await chrome.storage.local.get("history")).history || { contacts: {} };
      state.contacts ||= {};
      const key = postKey(originalUrl);
      const sentCount = Object.values(state.contacts).filter(record => record.status === "sent" && record.postKey === key).length;
      if (sentCount >= settings.maxContacts) throw new Error("The saved sent history reached this post's request limit.");
      const people = await message(tabId, "collectPostEngagers");
      const normalized = value => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const eligible = people.filter(person => !state.contacts[contactKey(person, key)] && normalized(person.name) !== normalized(settings.candidateName));
      const prepared = eligible.slice(0, settings.maxContacts - sentCount)
        .map(person => ({ person, note: makePostNote(settings, person, originalUrl) }));
      if (!prepared.length) throw new Error("No eligible commenters or reactors with visible profile roles were found.");
      if (prepared.some(item => !item.note)) throw new Error("A post note exceeds LinkedIn's 300 character limit. Shorten the post note template.");
      review = { source, tabId, originalUrl, postKey: key, settings, prepared, createdAt: Date.now() };
      prepared.forEach(({ person, note }, index) => renderPerson(person, note, `${person.engagement} · ${note.length}/300 characters · review before sending`, index));
      log(`Review ${prepared.length} post engager${prepared.length === 1 ? "" : "s"} and their notes. Tick each one you approve, then press Send selected.`);
      return;
    }
    restoreTab = true;
    const job = await message(tabId, "inspectJob");
    log(`Found ${job.title} at ${job.company || "the company"}.`);
    if (!jobMatches(job.title, settings)) throw new Error("Job title did not pass your keyword filters.");
    if (!experienceMatches(job.description, settings)) throw new Error("Job experience requirement did not pass your filters.");
    const root = companyRoot(job.companyUrl);
    if (!root) throw new Error("Company profile URL could not be read.");
    const slug = companySlug(root);
    const normalized = value => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (csv(settings.excludeCompanies).some(value => [slug, job.company].some(company => normalized(value) === normalized(company || "")))) {
      throw new Error("This company is on your exclusion list.");
    }
    const state = (await chrome.storage.local.get("history")).history || { contacts: {} };
    state.contacts ||= {};
    const sentForCompany = () => Object.values(state.contacts).filter(record => record.status === "sent" && record.companySlug === slug).length;
    const sentForJob = () => Object.values(state.contacts).filter(record => record.status === "sent" && record.jobKey === jobKey(job.url)).length;
    if (sentForJob() >= settings.maxContacts || sentForCompany() >= settings.maxPerCompany) {
      throw new Error("The saved sent history has reached the job or company limit.");
    }
    log("Checking the company people page.");
    await navigate(tabId, `${root}/people/`);
    let members = null;
    for (let attempt = 0; attempt < 10 && members === null; attempt++) {
      members = parseMemberCount(await message(tabId, "memberCountText"));
      if (members === null) await sleep(400);
    }
    if (members !== null && members < settings.minCompanyMembers) throw new Error(`Company has ${members.toLocaleString()} members; minimum is ${settings.minCompanyMembers.toLocaleString()}.`);
    log(members === null ? "Company size was unavailable. Looking for hiring contacts." : `Company has ${members.toLocaleString()} members. Looking for hiring contacts.`);
    let peopleUrl = `${root}/people/?keywords=hiring`;
    let candidates = await collectPeople(tabId, peopleUrl);
    let eligible = candidates.filter(person => !state.contacts[contactKey(person, slug)]);
    if (!eligible.length) {
      log("No available hiring contacts. Trying manager contacts.");
      peopleUrl = `${root}/people/?keywords=manager`;
      candidates = await collectPeople(tabId, peopleUrl);
      eligible = candidates.filter(person => !state.contacts[contactKey(person, slug)]);
    }
    const allowed = Math.min(settings.maxContacts - sentForJob(), settings.maxPerCompany - sentForCompany());
    const prepared = eligible.slice(0, allowed).map(person => ({ person, note: makeNote(settings, person, job) }));
    if (!prepared.length) throw new Error("No available connectable contacts found.");
    if (prepared.some(item => !item.note)) throw new Error("A note could not fit LinkedIn's 300 character limit. Shorten your resume URL or note template.");
    review = { source, tabId, originalUrl, job, slug, peopleUrl, settings, prepared, createdAt: Date.now() };
    prepared.forEach(({ person, note }, index) => renderPerson(person, note, `${note.length}/300 characters · review before sending`, index));
    log(`Review ${prepared.length} recipient${prepared.length === 1 ? "" : "s"} and their notes. Tick each one you approve, then press Send selected.`);
  } catch (error) {
    log(error.message || String(error));
  } finally {
    if (restoreTab && tabId && originalUrl) {
      try { await navigate(tabId, originalUrl); } catch { log("Could not return to the original job tab automatically."); }
    }
    busy = false;
    updateActions();
  }
}

async function sendSelected() {
  if (busy || !review) return;
  const chosen = [...$("results").querySelectorAll("input[data-review-index]:checked")]
    .map(input => Number(input.dataset.reviewIndex));
  if (!chosen.length) return;
  const snapshot = review;
  review = null;
  busy = true;
  updateActions();
  $("results").querySelectorAll("input[data-review-index]").forEach(input => { input.disabled = true; });
  let movedToPeople = false;
  try {
    if (Date.now() - snapshot.createdAt > 15 * 60 * 1000) throw new Error("This review expired. Find contacts again before sending.");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sameSource = snapshot.source === "post" ? postKey(active?.url || "") === snapshot.postKey
      : jobKey(active?.url || "https://www.linkedin.com/") === jobKey(snapshot.job.url);
    if (active?.id !== snapshot.tabId || !sameSource) {
      throw new Error("Return to the reviewed job or post tab before sending.");
    }
    const state = (await chrome.storage.local.get("history")).history || { contacts: {} };
    state.contacts ||= {};
    const sentForCompany = () => snapshot.source === "job" ? Object.values(state.contacts).filter(record => record.status === "sent" && record.companySlug === snapshot.slug).length : 0;
    const sentForSource = () => Object.values(state.contacts).filter(record => record.status === "sent" && (snapshot.source === "post" ? record.postKey === snapshot.postKey : record.jobKey === jobKey(snapshot.job.url))).length;
    if (snapshot.source === "job") {
      movedToPeople = true;
      await navigate(snapshot.tabId, snapshot.peopleUrl);
    }
    for (const index of chosen) {
      const { person, note } = snapshot.prepared[index];
      const box = $("results").children[index];
      const status = box.querySelector("small");
      const key = contactKey(person, snapshot.source === "post" ? snapshot.postKey : snapshot.slug);
      if (state.contacts[key]) { status.textContent = `${person.role} · already handled`; log(`${person.name} is already in sent history; skipped.`); continue; }
      if (sentForSource() >= snapshot.settings.maxContacts || (snapshot.source === "job" && sentForCompany() >= snapshot.settings.maxPerCompany)) {
        log("Saved sent history reached the request limit. Stopped.");
        return;
      }
      if (snapshot.source === "post") {
        movedToPeople = true;
        await navigate(snapshot.tabId, person.profileUrl);
      } else if (!(await revealPerson(snapshot.tabId, person.key))) {
        status.textContent = `${person.role} · unavailable`;
        log(`${person.name} is no longer available on the reviewed people page; skipped.`);
        continue;
      }
      state.contacts[key] = {
        status: "review", name: person.name, profileUrl: person.profileUrl, at: Date.now(),
        ...(snapshot.source === "post" ? { postKey: snapshot.postKey } : { companySlug: snapshot.slug, jobKey: jobKey(snapshot.job.url) })
      };
      await chrome.storage.local.set({ history: state });
      try {
        const result = await message(snapshot.tabId, snapshot.source === "post" ? "sendProfileRequest" : "sendRequest", { person, note });
        if (result.status === "sent") {
          state.contacts[key].status = "sent";
          status.textContent = `${person.role} · sent`;
          log(`Sent reviewed note to ${person.name}.`);
        } else if (result.status === "email_verification") {
          state.contacts[key].status = "email_verification";
          status.textContent = `${person.role} · email verification required`;
          log(`${person.name} requires email verification; skipped.`);
        } else if (result.status === "unavailable" || result.status === "ineligible") {
          delete state.contacts[key];
          status.textContent = `${person.role} · unavailable`;
          log(`${person.name} is no longer eligible or available; skipped.`);
        } else throw new Error("Unexpected invitation result. Review this contact on LinkedIn.");
      } catch (error) {
        status.textContent = `${person.role} · needs manual review`;
        log(`${person.name}: ${error.message}`);
        throw new Error("Stopped sending. Review the last contact on LinkedIn before another run.");
      } finally {
        await chrome.storage.local.set({ history: state });
      }
      await sleep(1200 + Math.floor(Math.random() * 1600));
    }
    log("Finished sending the selected notes.");
  } catch (error) {
    log(error.message || String(error));
  } finally {
    if (movedToPeople) {
      try { await navigate(snapshot.tabId, snapshot.originalUrl); } catch { log("Could not return to the original LinkedIn tab automatically."); }
    }
    busy = false;
    updateActions();
  }
}

for (const key of fields) {
  for (const event of ["input", "change"]) $(key).addEventListener(event, () => {
    if (!review) return;
    review = null;
    $("results").replaceChildren();
    log("Settings changed. Find contacts again to review the new notes.");
    updateActions();
  });
}

$("preview").addEventListener("click", findContacts);
$("send").addEventListener("click", sendSelected);
$("clearHistory").addEventListener("click", async () => {
  if (busy || !confirm("Delete this extension's local sent history? This cannot be undone.")) return;
  await chrome.storage.local.remove("history");
  review = null;
  $("results").replaceChildren();
  log("Local sent history cleared. Settings were kept.");
  updateActions();
});
updateActions();
