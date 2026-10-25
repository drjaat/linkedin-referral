(() => {
  if (globalThis.__jobOutreachListener) {
    try { chrome.runtime.onMessage.removeListener(globalThis.__jobOutreachListener); } catch { /* Previous extension context was reloaded. */ }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  const text = element => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  const linkedInUrl = href => {
    try {
      const url = new URL(href, location.origin);
      return /(^|\.)linkedin\.com$/.test(url.hostname) ? `${url.origin}${url.pathname}` : "";
    } catch { return ""; }
  };
  const click = element => { if (!visible(element)) throw new Error("The expected LinkedIn control is not visible."); element.click(); };
  const buttonNamed = (root, pattern) => [...root.querySelectorAll("button")]
    .find(button => visible(button) && pattern.test(`${text(button)} ${button.getAttribute("aria-label") || ""}`));
  const connectButtons = () => [...document.querySelectorAll("button")].filter(button => {
    if (!visible(button) || button.disabled) return false;
    const label = `${text(button)} ${button.getAttribute("aria-label") || ""}`;
    return /\bconnect\b/i.test(label) || /invite .+ to connect/i.test(label);
  });

  function readJobTitle(companyAnchor) {
    const selectors = [
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".job-details-jobs-unified-top-card [class*='job-title']",
      ".jobs-unified-top-card [class*='job-title']",
      ".job-details-jobs-unified-top-card h1",
      ".job-details-jobs-unified-top-card h2",
      ".jobs-unified-top-card h1",
      ".jobs-unified-top-card h2",
      "[data-test-job-title]"
    ];
    for (const selector of selectors) {
      const match = [...document.querySelectorAll(selector)].find(element => visible(element) && text(element).length >= 8);
      if (match) return text(match);
    }
    let card = companyAnchor?.parentElement;
    for (let depth = 0; card && depth < 8; depth++, card = card.parentElement) {
      if (!visible(card)) continue;
      const lines = (card.innerText || "").split(/\n+/).map(line => line.trim()).filter(Boolean);
      const companyIndex = lines.findIndex(line => line === text(companyAnchor));
      const nextLine = lines[companyIndex + 1] || "";
      if (companyIndex >= 0 && nextLine.length >= 8 && nextLine.length <= 180 && nextLine !== text(companyAnchor)) {
        return nextLine;
      }
    }
    const metadata = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
    const fallback = metadata.split(/\s+[|]\s+/)[0].replace(/\s+[-–]\s+LinkedIn$/i, "").trim();
    return fallback.length >= 8 && !/^linkedin\b/i.test(fallback) ? fallback : "";
  }

  async function inspectJob() {
    const jobUrl = linkedInUrl(location.href);
    if (!/^\/jobs\/view\/\d+/.test(location.pathname)) throw new Error("Open a LinkedIn job detail URL (/jobs/view/...) first.");
    let title = "";
    let companyAnchor;
    for (let attempt = 0; attempt < 20; attempt++) {
      companyAnchor = [...document.querySelectorAll("a[href*='/company/']")]
        .find(anchor => !/\/jobs\//.test(anchor.getAttribute("href") || "") && visible(anchor));
      title = readJobTitle(companyAnchor);
      if (title && companyAnchor) break;
      await sleep(300);
    }
    if (!title) throw new Error("Could not read the job title from this LinkedIn page.");
    if (!companyAnchor) throw new Error("Could not find the company profile link on this job.");
    const companyUrl = linkedInUrl(companyAnchor.href);
    const company = text(companyAnchor) || text(document.querySelector(".job-details-jobs-unified-top-card__company-name"));
    const description = text(document.querySelector(".jobs-description__content, .jobs-box__html-content, #job-details, .jobs-description-content__text, [data-test-job-description]"));
    return { url: jobUrl, title, company, companyUrl, description };
  }

  function memberCountText() {
    if (!/^\/company\/[^/]+\/people\/?$/.test(location.pathname)) throw new Error("Company people overview did not load.");
    const focused = [...document.querySelectorAll("h1, h2, h3, p, span, div")]
      .filter(el => el.children.length < 3 && /\b(?:members|employees)\b/i.test(text(el)) && text(el).length < 160)
      .map(text);
    return focused.join("\n") || text(document.body).slice(0, 12000);
  }

  function personFromButton(button) {
    const card = button.closest("li, .discover-person-card, .artdeco-card");
    if (!card) return null;
    const profileLink = card.querySelector("a[href*='/in/']");
    const profileUrl = profileLink ? linkedInUrl(profileLink.href) : "";
    const inviteName = (button.getAttribute("aria-label") || "").match(/invite\s+(.+?)\s+to\s+connect/i)?.[1];
    const name = text(profileLink) || inviteName || text(card.querySelector(".artdeco-entity-lockup__title, .discover-person-card__name, h3, h4"));
    if (!name || name.toLowerCase() === "there") return null;
    const cleanName = name.split(" · ")[0].replace(/\s+(?:1st|2nd|3rd)\b.*$/i, "").trim();
    const roleSelectors = [
      ".org-people-profile-card__profile-info .artdeco-entity-lockup__subtitle",
      ".artdeco-entity-lockup__subtitle",
      ".discover-person-card__occupation",
      ".org-people-profile-card__profile-info .t-14"
    ];
    let role = "";
    for (const selector of roleSelectors) {
      const element = card.querySelector(selector);
      if (visible(element) && text(element) && text(element) !== cleanName && !/^(?:1st|2nd|3rd|connect|follow|message)$/i.test(text(element))) {
        role = text(element);
        break;
      }
    }
    if (!role) {
      const lines = (card.innerText || "").split(/\n+/).map(line => line.trim()).filter(Boolean);
      const nameIndex = lines.findIndex(line => line === cleanName || line.startsWith(`${cleanName} ·`));
      role = (nameIndex < 0 ? [] : lines.slice(nameIndex + 1)).find(line =>
        !/^(?:1st|2nd|3rd|connect|follow|message|view profile|more)$/i.test(line) && /[a-z]/i.test(line)
      ) || "";
    }
    if (isInternRole(card.innerText || "")) role = "";
    return { name: cleanName, profileUrl, key: profileUrl || cleanName.toLowerCase(), role };
  }

  const isInternRole = role => /\b(?:intern|interns|internship|internships)\b/i.test(role);
  const eligiblePerson = person => Boolean(person?.profileUrl && person.role && !isInternRole(person.role));

  function listCandidates() {
    if (!/^\/company\/[^/]+\/people\/?$/.test(location.pathname)) throw new Error("Company people page did not load.");
    const seen = new Set();
    return connectButtons().map(personFromButton).filter(person => {
      if (!eligiblePerson(person) || seen.has(person.key)) return false;
      seen.add(person.key);
      return true;
    });
  }

  function postPersonFromCard(card, engagement) {
    const link = [...card.querySelectorAll("a[href*='/in/']")].find(anchor => linkedInUrl(anchor.href).includes("/in/"));
    if (!link) return null;
    const profileUrl = linkedInUrl(link.href);
    const rawName = (link.innerText || "").split("\n")[0].trim() ||
      (link.getAttribute("aria-label") || "").match(/view (.+?)(?:'s|’s) profile/i)?.[1] || "";
    const name = rawName.split(" · ")[0].replace(/\s+(?:1st|2nd|3rd)\b.*$/i, "").trim();
    const headline = card.querySelector(
      ".comments-post-meta__headline, .comments-comment-item__commenter-headline, .artdeco-entity-lockup__subtitle, .social-details-reactors-tab-body__occupation, .reactors-info__headline"
    );
    const role = text(headline);
    if (!name || !profileUrl || !role || isInternRole(role)) return null;
    return { name, profileUrl, key: profileUrl, role, engagement };
  }

  function postRoot() {
    if (!/^\/(?:posts\/[^/]+|feed\/update\/urn:li:(?:activity|ugcPost):[^/]+)/.test(location.pathname)) {
      throw new Error("Open a specific LinkedIn post link (/posts/... or /feed/update/...) first.");
    }
    return document.querySelector(".feed-shared-update-v2, article[data-urn], [data-urn*='activity']") || document.querySelector("main");
  }

  function commenters(root) {
    const cards = root.querySelectorAll(".comments-comment-item, .comments-comment-item__main-content");
    return [...cards].map(card => postPersonFromCard(card, "comment")).filter(Boolean);
  }

  async function reactors(root) {
    const opener = [...root.querySelectorAll(
      ".social-details-social-counts__reactions-count, .social-details-social-counts__reactions, a[aria-label*='reactions' i], button[aria-label*='reactions' i]"
    )].find(element => visible(element) && /\d|reactions?/i.test(`${text(element)} ${element.getAttribute("aria-label") || ""}`));
    if (!opener) return [];
    opener.click();
    await sleep(500);
    const modal = [...document.querySelectorAll(".artdeco-modal, [role='dialog']")]
      .find(element => visible(element) && /reactions?|likes?/i.test(text(element).slice(0,150)));
    if (!modal) return [];
    const found = new Map();
    try {
      for (let round = 0; round < 6 && found.size < 50; round++) {
        const cards = modal.querySelectorAll("li, .artdeco-entity-lockup, .social-details-reactors-tab-body__reactor-item");
        for (const card of cards) {
          const person = postPersonFromCard(card, "reaction");
          if (person) found.set(person.key, person);
        }
        const scroller = modal.querySelector(".artdeco-modal__content, .social-details-reactors-tab-body, [role='list']") || modal;
        scroller.scrollTop += Math.max(500, scroller.clientHeight || 500);
        await sleep(350);
      }
    } finally {
      buttonNamed(modal, /close|dismiss/i)?.click();
    }
    return [...found.values()];
  }

  async function collectPostEngagers() {
    const root = postRoot();
    if (!root) throw new Error("Could not locate the post on this page.");
    for (let round = 0; round < 3; round++) {
      const more = buttonNamed(root, /more comments|load more comments|see more comments/i);
      if (!more) break;
      more.click();
      await sleep(450);
    }
    const found = new Map();
    for (const person of await reactors(root)) found.set(person.key, person);
    for (const person of commenters(root)) found.set(person.key, person);
    return [...found.values()].slice(0, 50);
  }

  async function showMore() {
    const more = buttonNamed(document, /show more results|see more results/i);
    if (more) { more.click(); await sleep(800); return true; }
    const before = document.documentElement.scrollHeight;
    window.scrollBy(0, 1400);
    await sleep(800);
    return document.documentElement.scrollHeight > before || window.scrollY > 0;
  }

  async function sendInvitation(connectButton, note) {
    click(connectButton);
    await sleep(650);
    let dialog = [...document.querySelectorAll(".artdeco-modal, [role='dialog']")].filter(visible).pop();
    if (!dialog) throw new Error("LinkedIn did not open the invitation dialog. Check the page before retrying.");
    const close = () => {
      const dismiss = buttonNamed(dialog, /dismiss|cancel|close/i);
      if (dismiss) dismiss.click();
    };
    const emailGate = () => Boolean(dialog.querySelector("input[type='email'], input[name*='email' i]")) || /enter their email to connect|verify this member knows you/i.test(text(dialog));
    if (emailGate()) { close(); return { status: "email_verification" }; }
    const addNote = buttonNamed(dialog, /add a note|add note/i);
    if (addNote) { addNote.click(); await sleep(350); }
    dialog = [...document.querySelectorAll(".artdeco-modal, [role='dialog']")].filter(visible).pop() || dialog;
    if (emailGate()) { close(); return { status: "email_verification" }; }
    const input = dialog.querySelector("textarea[name='message'], textarea#custom-message, textarea");
    if (!visible(input)) { close(); throw new Error("LinkedIn did not provide a note field; no request was sent."); }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter.call(input, note);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    const send = buttonNamed(dialog, /^send(?: now)?\b|send invitation/i);
    if (!send || send.disabled) { close(); throw new Error("The Send button is unavailable; no request was sent."); }
    send.click();
    for (let attempt = 0; attempt < 16; attempt++) {
      await sleep(250);
      if (!visible(dialog)) return { status: "sent" };
      if (/invitation sent|request sent/i.test(text(dialog))) return { status: "sent" };
      if (emailGate()) { close(); return { status: "email_verification" }; }
    }
    throw new Error("Send result is uncertain. Check LinkedIn before trying this person again.");
  }

  async function sendRequest({ person, note }) {
    if (!person?.key || typeof note !== "string" || !note.trim() || note.length > 300) throw new Error("Invalid recipient or note.");
    const button = connectButtons().find(candidate => personFromButton(candidate)?.key === person.key);
    if (!button) return { status: "unavailable" };
    const current = personFromButton(button);
    if (!eligiblePerson(current) || current.name !== person.name || current.profileUrl !== person.profileUrl || current.role !== person.role) {
      return { status: "ineligible" };
    }
    return sendInvitation(button, note);
  }

  async function sendProfileRequest({ person, note }) {
    if (!person?.profileUrl || !person.name || !note?.trim() || note.length > 300) throw new Error("Invalid recipient or note.");
    const currentUrl = linkedInUrl(location.href).replace(/\/+$/, "");
    if (currentUrl !== person.profileUrl.replace(/\/+$/, "")) return { status: "ineligible" };
    const top = document.querySelector(".pv-top-card, .scaffold-layout__main .artdeco-card, main .artdeco-card");
    if (!top) return { status: "ineligible" };
    const name = text(top.querySelector("h1, .text-heading-xlarge"));
    const role = text(top.querySelector(".text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium, .top-card-layout__headline"));
    const normalized = value => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!name || normalized(name) !== normalized(person.name) || !role || isInternRole(role) || normalized(role) !== normalized(person.role)) {
      return { status: "ineligible" };
    }
    let connect = buttonNamed(top, /^connect\b|invite .+ to connect/i);
    if (!connect) {
      const more = buttonNamed(top, /^more\b/i);
      if (!more) return { status: "unavailable" };
      more.click();
      await sleep(250);
      connect = [...document.querySelectorAll("[role='menuitem'], .artdeco-dropdown__item, button")]
        .find(element => visible(element) && /^connect\b/i.test(text(element)));
    }
    if (!connect) return { status: "unavailable" };
    return sendInvitation(connect, note);
  }

  const listener = (message, sender, reply) => {
    (async () => {
      switch (message?.type) {
        case "ping": return { ok: true };
        case "inspectJob": return inspectJob();
        case "memberCountText": return memberCountText();
        case "listCandidates": return listCandidates();
        case "collectPostEngagers": return collectPostEngagers();
        case "showMore": return showMore();
        case "sendRequest": return sendRequest(message.payload);
        case "sendProfileRequest": return sendProfileRequest(message.payload);
        default: throw new Error("Unknown extension action.");
      }
    })().then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message || String(error) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__jobOutreachListener = listener;
})();
