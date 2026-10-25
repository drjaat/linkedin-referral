import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../extension/", import.meta.url));
const output = fileURLToPath(new URL("../dist/store-screenshot-1280x800.jpg", import.meta.url));
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    const tab = { id: 1, url: "https://www.linkedin.com/jobs/view/123456/", status: "complete" };
    const data = {};
    const people = [
      { name: "Sam Example", profileUrl: "https://www.linkedin.com/in/sample-contact-one/", key: "https://www.linkedin.com/in/sample-contact-one/", role: "Engineering Manager" },
      { name: "Alex Sample", profileUrl: "https://www.linkedin.com/in/sample-contact-two/", key: "https://www.linkedin.com/in/sample-contact-two/", role: "Technical Recruiter" }
    ];
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
          const result = message.type === "inspectJob" ? {
            url: "https://www.linkedin.com/jobs/view/123456/", title: "Senior Software Engineer", company: "Example Company",
            companyUrl: "https://www.linkedin.com/company/example-company/", description: "6 years of experience"
          } : message.type === "memberCountText" ? "5,000 associated members"
            : message.type === "listCandidates" ? people
            : message.type === "showMore" ? false : { status: "unavailable" };
          return { ok: true, result };
        }
      },
      scripting: { executeScript: async () => {} }
    } });
  });

  const page = await context.newPage();
  const wrapper = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; } body { margin: 0; font-family: Arial, sans-serif; color: #123047;
      background: radial-gradient(circle at 85% 10%, #d8f5f0 0, transparent 35%), linear-gradient(135deg, #f7fafc, #eaf1f7); }
    .layout { width: 1280px; height: 800px; display: flex; align-items: center; justify-content: space-between; padding: 58px 78px; }
    .copy { width: 570px; } .eyebrow { color: #087e78; font-size: 15px; font-weight: 800; letter-spacing: .16em; }
    h1 { font-size: 58px; line-height: 1.06; letter-spacing: -.035em; margin: 22px 0; }
    .lead { font-size: 24px; line-height: 1.4; color: #455f70; margin: 0 0 40px; }
    .step { display: flex; align-items: center; gap: 16px; margin: 17px 0; font-size: 20px; font-weight: 700; }
    .number { display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; color: white; background: #0b76c7; font-size: 17px; }
    .foot { margin-top: 42px; font-size: 14px; color: #647b8d; }
    .panel { width: 460px; height: 686px; border: 1px solid #b5c7d5; border-radius: 18px; overflow: hidden;
      background: white; box-shadow: 0 22px 55px #0b28422b; }
    iframe { border: 0; width: 100%; height: 100%; }
  </style></head><body><div class="layout"><div class="copy">
    <div class="eyebrow">LINKEDIN JOB OUTREACH</div>
    <h1>Review every request before it goes out.</h1>
    <p class="lead">Find job contacts or people who engaged with a post. Check profiles and notes, then choose who to contact.</p>
    <div class="step"><span class="number">1</span> Open a LinkedIn job or post</div>
    <div class="step"><span class="number">2</span> Review contacts and full notes</div>
    <div class="step"><span class="number">3</span> Select recipients to send</div>
    <p class="foot">Sample contacts shown. Independent tool, not affiliated with LinkedIn.</p>
  </div><div class="panel"><iframe src="/panel.html" title="Extension preview"></iframe></div></div></body></html>`;
  await page.route("https://extension-preview.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/store-preview.html") {
      await route.fulfill({ status: 200, contentType: "text/html", body: wrapper });
      return;
    }
    const filename = path.join(root, pathname);
    const contentType = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
    await route.fulfill({ status: 200, contentType, body: await fs.readFile(filename) });
  });
  await page.goto("https://extension-preview.test/store-preview.html");
  const panel = page.frameLocator("iframe");
  await panel.locator("#candidateName").fill("Taylor Candidate");
  await panel.locator("#resumeUrl").fill("https://example.com/resume");
  await panel.locator("#preview").click();
  await panel.locator("#results .person").nth(1).waitFor();
  await panel.locator("#preview").evaluate(element => element.scrollIntoView({ block: "start" }));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, type: "jpeg", quality: 90 });
  console.log(output);
  await context.close();
} finally {
  await browser.close();
}
