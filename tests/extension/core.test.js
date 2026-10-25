import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, migrateSettings, companyRoot, jobKey, isPostUrl, postKey, jobMatches, experienceRequirement, experienceMatches, parseMemberCount, shortJobTitle, makeNote, makePostNote } from "../../extension/core.js";

test("extracts the active job and company IDs from LinkedIn URLs", () => {
  assert.equal(jobKey("https://www.linkedin.com/jobs/view/123456/?trackingId=x"), "123456");
  assert.equal(companyRoot("https://www.linkedin.com/company/example-co/people/?keywords=hiring"), "https://www.linkedin.com/company/example-co");
  assert.equal(companyRoot("https://example.com/company/example-co"), null);
});

test("applies title and experience filters", () => {
  const settings = { ...DEFAULTS, includeKeywords: "frontend,react" };
  assert.equal(jobMatches("Senior Frontend Engineer", settings), true);
  assert.equal(jobMatches("Frontend QA Engineer", settings), false);
  assert.equal(jobMatches("Backend Engineer", settings), false);
  assert.equal(experienceRequirement("Minimum of 6 years of experience"), 6);
  assert.equal(experienceMatches("10+ years of experience", settings), false);
  assert.equal(experienceMatches("6 years of experience", settings), true);
});

test("parses the company member count and builds a bounded note", () => {
  assert.equal(parseMemberCount("1,234 associated members"), 1234);
  assert.equal(parseMemberCount("1,234+ associated members"), 1234);
  assert.equal(parseMemberCount("2,400 employees"), 2400);
  assert.equal(parseMemberCount("2.5k members"), 2500);
  assert.equal(parseMemberCount("No member total shown"), null);
  const settings = { ...DEFAULTS, candidateName: "Alex Example", resumeUrl: "https://example.com/resume" };
  const note = makeNote(settings, { name: "Sam Lee" }, { title: "Frontend Engineer", url: "https://www.linkedin.com/jobs/view/123456/" });
  assert.match(note, /Hi Sam/);
  assert.match(note, /Senior Software Engineer – Frontend\/Full Stack/);
  assert.ok(note.length <= 300);
});

test("formats the default note with paragraph breaks and updates only the previous default", () => {
  const settings = { ...DEFAULTS, candidateName: "Alex Example", resumeUrl: "https://example.com/resume" };
  const note = makeNote(settings, { name: "Sam Lee" }, { title: "Frontend Engineer", url: "https://www.linkedin.com/jobs/view/123456/" });
  assert.equal(note, "Hi Sam,\nI found the Senior Software Engineer – Frontend/Full Stack role and it fits my background. Would you consider referring me?\n\nResume: https://example.com/resume\nJob: https://www.linkedin.com/jobs/view/123456/\n\nThanks,\nAlex");
  const old = "Hi {FirstName}, I found the {JobTitle} role and it fits my background. Would you consider referring me? Resume: {ResumeUrl} Job: {JobUrl} Thanks, {Signature}";
  const previous = "Hi {FirstName},\nI found the {JobTitle} role and it fits my background. Would you consider referring me?\n\nResume: {ResumeUrl}\nJob: {JobUrl}\n\nThanks,\n{Signature}";
  assert.equal(migrateSettings({ noteTemplate: old }).noteTemplate, DEFAULTS.noteTemplate);
  assert.equal(migrateSettings({ noteTemplate: previous }).noteTemplate, DEFAULTS.noteTemplate);
  assert.equal(migrateSettings({ noteTemplate: previous, roleTitle: "My role" }).noteTemplate, previous);
  assert.equal(migrateSettings({ noteTemplate: "Custom note" }).noteTemplate, "Custom note");
  assert.equal(makeNote({ ...settings, resumeUrl: `https://example.com/${"x".repeat(250)}` }, { name: "Sam Lee" }, { title: "Frontend Engineer", url: "https://www.linkedin.com/jobs/view/123456/" }), null);
});

test("shortens long job titles and allows a fixed role name in notes", () => {
  const longTitle = "Sr. Software Engineer – Full Stack & ServiceNow (React, Node.js, Python, ITSM, 4-6 years)";
  assert.equal(shortJobTitle(longTitle), "Senior Software Engineer – Full Stack");
  assert.equal(shortJobTitle("Senior Full Stack Engineer - Collibra & Governance Technology"), "Senior Full Stack Engineer");
  const settings = { ...DEFAULTS, candidateName: "Alex Example", resumeUrl: "https://example.com/resume", roleTitle: "Senior Software Engineer – Frontend/Full Stack", noteTemplate: "Hi {FirstName}, I found the {JobTitle} role. Job: {JobUrl}" };
  const note = makeNote(settings, { name: "Sam Lee" }, { title: longTitle, url: "https://www.linkedin.com/jobs/view/123456/" });
  assert.match(note, /Senior Software Engineer – Frontend\/Full Stack role/);
  assert.match(note, /Job: https:\/\/www\.linkedin\.com\/jobs\/view\/123456\//);
});

test("recognizes specific LinkedIn posts and formats bounded engagement notes", () => {
  const post = "https://www.linkedin.com/feed/update/urn:li:activity:12345/?trackingId=abc";
  assert.equal(isPostUrl(post), true);
  assert.equal(postKey(post), "/feed/update/urn:li:activity:12345");
  assert.equal(isPostUrl("https://www.linkedin.com/posts/example_activity-12345/"), true);
  assert.equal(isPostUrl("https://example.com/posts/example_activity-12345/"), false);
  assert.equal(isPostUrl("https://www.linkedin.com/feed/"), false);
  const settings = { ...DEFAULTS, candidateName: "Taylor Candidate" };
  const note = makePostNote(settings, { name: "Sam Lee", engagement: "comment" }, post);
  assert.equal(note, "Hi Sam,\nI noticed your comment on a post I found interesting and thought it would be great to connect.\n\nThanks,\nTaylor");
  assert.equal(makePostNote({ ...settings, postNoteTemplate: "x".repeat(301) }, { name: "Sam Lee", engagement: "reaction" }, post), null);
});
