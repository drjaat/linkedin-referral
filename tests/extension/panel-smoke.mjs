import { chromium } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../extension/", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "job-outreach-load-"));
try {
  const loaded = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = loaded.serviceWorkers()[0] || await loaded.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionUrl = new URL(worker.url());
    assert.equal(extensionUrl.protocol, "chrome-extension:");
    const panel = await loaded.newPage();
    await panel.goto(`chrome-extension://${extensionUrl.host}/panel.html`);
    await panel.locator("#preview").waitFor();
  } finally {
    await loaded.close();
  }
} finally {
  await fs.rm(profile, { recursive: true, force: true });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const tab = { id: 1, url: "https://www.linkedin.com/jobs/view/123456/", status: "complete" };
    const data = {};
    const sent = [];
    const people = [
      { name: "Alex Engineer", profileUrl: "https://www.linkedin.com/in/alex/", key: "https://www.linkedin.com/in/alex/", role: "Engineering Manager" },
      { name: "Sam Recruiter", profileUrl: "https://www.linkedin.com/in/sam/", key: "https://www.linkedin.com/in/sam/", role: "Senior Recruiter" }
    ];
    const postPeople = [
      { name: "Ava Commenter", profileUrl: "https://www.linkedin.com/in/ava/", key: "https://www.linkedin.com/in/ava/", role: "Software Engineer", engagement: "comment" },
      { name: "Ben Reactor", profileUrl: "https://www.linkedin.com/in/ben/", key: "https://www.linkedin.com/in/ben/", role: "Engineering Manager", engagement: "reaction" }
    ];
    window.__mock = { tab, data, sent, people, postPeople };
    Object.defineProperty(window, "chrome", { configurable: true, value: {
      storage: { local: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]])),
        set: async values => Object.assign(data, values),
        remove: async key => { delete data[key]; }
      } },
      tabs: {
        query: async () => [tab],
        get: async () => tab,
        update: async (_id, update) => { tab.url = update.url; return tab; },
        sendMessage: async (_id, message) => {
          const value = message.type === "inspectJob" ? { url: "https://www.linkedin.com/jobs/view/123456/", title: "Senior Software Engineer", company: "Example", companyUrl: "https://www.linkedin.com/company/example/", description: "6 years of experience" }
            : message.type === "memberCountText" ? "5,000 associated members"
            : message.type === "listCandidates" ? people
            : message.type === "collectPostEngagers" ? postPeople
            : message.type === "showMore" ? false
            : message.type === "sendRequest" ? (sent.push(message.payload), { status: "sent" })
            : message.type === "sendProfileRequest" ? (sent.push(message.payload), { status: "sent" })
            : { ok: true };
          return { ok: true, result: value };
        }
      },
      scripting: { executeScript: async () => {} }
    } });
  });
  const page = await context.newPage();
  await page.route("https://extension.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.join(root, pathname);
    const contentType = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
    await route.fulfill({ status: 200, contentType, body: await fs.readFile(file) });
  });
  await page.goto("https://extension.test/panel.html");
  await page.locator("#candidateName").fill("Taylor Candidate");
  await page.locator("#resumeUrl").fill("https://example.com/resume");
  assert.equal(await page.locator("#send").isDisabled(), true);
  await page.locator("#preview").click();
  await page.locator("#results .person").nth(1).waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await page.locator("#results .person a").nth(1).getAttribute("href"), "https://www.linkedin.com/in/sam/");
  await page.locator("#results input[type=checkbox]").first().check();
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5000 });
  await page.locator("#candidateName").fill("Updated Candidate");
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await page.locator("#results .person").count(), 0);
  await page.locator("#preview").click();
  await page.locator("#results .person").nth(1).waitFor({ timeout: 30000 });
  await page.locator("#results input[type=checkbox]").nth(1).check();
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#send").isEnabled(), true);
  const displayed = await page.locator("#results .person pre").nth(1).textContent();
  await page.locator("#send").click();
  await page.locator("#status").getByText("Finished sending the selected notes.").waitFor({ timeout: 30000 });
  const result = await page.evaluate(() => ({ sent: window.__mock.sent, history: window.__mock.data.history }));
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].person.name, "Sam Recruiter");
  assert.equal(result.sent[0].note, displayed);
  assert.equal(Object.values(result.history.contacts).filter(record => record.status === "sent").length, 1);
  page.on("dialog", dialog => dialog.accept());
  await page.locator("#clearHistory").click();
  await page.locator("#status").getByText("Local sent history cleared. Settings were kept.").waitFor();
  assert.equal(await page.evaluate(() => "history" in window.__mock.data), false);
  await page.evaluate(() => { window.__mock.tab.url = "https://www.linkedin.com/feed/update/urn:li:activity:12345/"; });
  await page.locator("#preview").click();
  await page.locator("#results .person").nth(1).waitFor();
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await page.locator("#results input[type=checkbox]:checked").count(), 0);
  assert.match(await page.locator("#results .person pre").first().textContent(), /your comment/);
  await page.locator("#results input[type=checkbox]").nth(1).check();
  const postNote = await page.locator("#results .person pre").nth(1).textContent();
  await page.locator("#send").click();
  await page.locator("#status").getByText("Finished sending the selected notes.").waitFor({ timeout: 30000 });
  const postResult = await page.evaluate(() => ({ sent: window.__mock.sent, history: window.__mock.data.history, url: window.__mock.tab.url }));
  assert.equal(postResult.sent.length, 2);
  assert.equal(postResult.sent[1].person.name, "Ben Reactor");
  assert.equal(postResult.sent[1].note, postNote);
  assert.equal(postResult.url, "https://www.linkedin.com/feed/update/urn:li:activity:12345/");
  assert.equal(Object.values(postResult.history.contacts).filter(record => record.status === "sent").length, 1);
  console.log("Panel smoke test passed: job and post sends require reviewed selections and use the displayed notes.");
  await context.close();
} finally {
  await browser.close();
}
