const PREVIOUS_DEFAULT_NOTE_TEMPLATES = new Set([
  "Hi {FirstName}, I found the {JobTitle} role and it fits my background. Would you consider referring me? Resume: {ResumeUrl} Job: {JobUrl} Thanks, {Signature}",
  `Hi {FirstName},
I found the {JobTitle} role and it fits my background. Would you consider referring me?

Resume: {ResumeUrl}
Job: {JobUrl}

Thanks,
{Signature}`
]);

export const DEFAULTS = {
  resumeUrl: "",
  candidateName: "",
  signature: "",
  roleTitle: "",
  noteTemplate: `Hi {FirstName},
I found the Senior Software Engineer – Frontend/Full Stack role and it fits my background. Would you consider referring me?

Resume: {ResumeUrl}
Job: {JobUrl}

Thanks,
{Signature}`,
  postNoteTemplate: `Hi {FirstName},
I noticed your {Engagement} on a post I found interesting and thought it would be great to connect.

Thanks,
{Signature}`,
  includeKeywords: "",
  excludeKeywords: "intern,contract,qa",
  excludeCompanies: "",
  maxContacts: 5,
  maxPerCompany: 5,
  minCompanyMembers: 100,
  filterExperience: true,
  minYears: 5,
  maxYears: 9,
  candidateYears: 7,
  internshipYears: 1,
  internshipWeight: 1
};

export function migrateSettings(settings = {}) {
  if (!PREVIOUS_DEFAULT_NOTE_TEMPLATES.has(settings.noteTemplate) || settings.roleTitle) return settings;
  return { ...settings, noteTemplate: DEFAULTS.noteTemplate };
}

export function csv(value) {
  return String(value || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

export function jobKey(url) {
  return new URL(url).pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || new URL(url).pathname;
}

export function isPostUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)linkedin\.com$/.test(url.hostname) && (/^\/posts\/[^/]+/.test(url.pathname) || /^\/feed\/update\/urn:li:(?:activity|ugcPost):[^/]+/.test(url.pathname));
  } catch { return false; }
}

export function postKey(rawUrl) {
  if (!isPostUrl(rawUrl)) return "";
  return new URL(rawUrl).pathname.replace(/\/+$/, "");
}

export function companyRoot(url) {
  const parsed = new URL(url);
  if (!/(^|\.)linkedin\.com$/.test(parsed.hostname)) return null;
  const slug = parsed.pathname.match(/^\/company\/([^/]+)/)?.[1];
  return slug ? `https://www.linkedin.com/company/${slug}` : null;
}

export function companySlug(url) {
  return companyRoot(url)?.split("/").pop() || "";
}

export function jobMatches(title, settings) {
  const clean = String(title || "").toLowerCase();
  if (csv(settings.excludeKeywords).some(x => clean.includes(x))) return false;
  const included = csv(settings.includeKeywords);
  return !included.length || included.some(x => clean.includes(x));
}

export function experienceRequirement(text) {
  const patterns = [
    /(?:at least|minimum(?: of)?)\s+(\d{1,2})\s*(?:years?|yrs?)/gi,
    /(\d{1,2})\s*(?:[-–]|to)\s*\d{1,2}\s*(?:years?|yrs?)/gi,
    /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/gi,
    /(\d{1,2})\s*\+\s*(?:years?|yrs?)/gi
  ];
  const years = patterns.flatMap(pattern => [...String(text || "").matchAll(pattern)]
    .map(match => Number(match[1])).filter(value => value > 0 && value <= 25));
  return years.length ? Math.max(...years) : null;
}

export function experienceMatches(description, settings) {
  if (!settings.filterExperience) return true;
  const years = experienceRequirement(description);
  if (years === null) return true;
  const effective = Number(settings.candidateYears) + Number(settings.internshipYears) * Number(settings.internshipWeight);
  return years >= Number(settings.minYears) && years <= Number(settings.maxYears) && years <= effective + 1;
}

export function parseMemberCount(text) {
  const matches = [...String(text || "").matchAll(/([\d,.]+\s*[kmb]?)\s*\+?\s*(?:(?:associated|on linkedin)\s+)?(?:members|employees)\b/gi)];
  const values = matches.map(match => {
    const number = match[1].trim().toLowerCase().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
    if (!number) return NaN;
    return Math.round(Number(number[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[number[2]] || 1));
  }).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

export function shortJobTitle(title) {
  const clean = String(title || "")
    .replace(/\bSr\.?(?=\s)/gi, "Senior")
    .replace(/\bJr\.?(?=\s)/gi, "Junior")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ").trim();
  let base = clean.split(/\s+[-–—]\s+/)[0].trim();
  if (base.length > 60) base = base.slice(0, 61).replace(/\s+\S*$/, "").trim();
  const specialty = /\bfull[\s-]*stack\b/i.test(clean) ? "Full Stack"
    : /\bfront[\s-]*end\b/i.test(clean) ? "Frontend"
    : /\bback[\s-]*end\b/i.test(clean) ? "Backend" : "";
  if (specialty && !new RegExp(specialty.replace(" ", "[\\s-]*"), "i").test(base) && /\b(?:engineer|developer)\b/i.test(base)) {
    base += ` – ${specialty}`;
  }
  return base || "Software Engineer";
}

export function makeNote(settings, person, job) {
  const firstName = person.name.trim().split(/\s+/)[0] || "there";
  const title = String(settings.roleTitle || "").trim() || shortJobTitle(job.title);
  const replacements = {
    FirstName: firstName,
    JobTitle: title,
    ResumeUrl: settings.resumeUrl.trim(),
    JobUrl: job.url,
    Signature: settings.signature.trim() || settings.candidateName.trim().split(/\s+/)[0],
    CandidateName: settings.candidateName.trim()
  };
  const interpolate = template => template.replace(/\{(\w+)\}/g, (_, key) => replacements[key] || "");
  const normalize = value => value.replace(/\r/g, "").split("\n").map(line => line.trim().replace(/[ \t]+/g, " ")).join("\n").trim();
  const requested = normalize(interpolate(settings.noteTemplate));
  if (requested.length <= 300) return requested;
  if (settings.noteTemplate === DEFAULTS.noteTemplate) return null;
  const options = [
    interpolate("Hi {FirstName}, I found the {JobTitle} role. Would you consider referring me? Resume: {ResumeUrl} Job: {JobUrl} Thanks, {Signature}"),
    interpolate("Hi {FirstName}, could you consider a referral? Resume: {ResumeUrl} Job: {JobUrl} Thanks, {Signature}")
  ];
  return options.map(normalize).find(note => note.length <= 300) || null;
}

export function makePostNote(settings, person, postUrl) {
  const values = {
    FirstName: person.name.trim().split(/\s+/)[0] || "there",
    Engagement: person.engagement === "comment" ? "comment" : "reaction",
    PostUrl: postUrl,
    Signature: settings.signature.trim() || settings.candidateName.trim().split(/\s+/)[0],
    CandidateName: settings.candidateName.trim()
  };
  const note = String(settings.postNoteTemplate || "")
    .replace(/\{(\w+)\}/g, (_, key) => values[key] || "")
    .replace(/\r/g, "")
    .split("\n").map(line => line.trim().replace(/[ \t]+/g, " ")).join("\n").trim();
  return note && note.length <= 300 ? note : null;
}
