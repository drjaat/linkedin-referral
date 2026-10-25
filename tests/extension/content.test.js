import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("reads a visible job title from LinkedIn's top card heading", async () => {
  let listener;
  const listeners = new Set();
  const heading = { innerText: "Senior Full Stack Engineer - Collibra & Governance Technology", getClientRects: () => [1] };
  const hiddenOldHeading = { innerText: "", getClientRects: () => [] };
  const company = {
    innerText: "Macquarie Group",
    href: "https://www.linkedin.com/company/macquarie-group/",
    getAttribute: () => "/company/macquarie-group/",
    getClientRects: () => [1]
  };
  const context = {
    URL,
    location: { href: "https://www.linkedin.com/jobs/view/4477065882/?alternateChannel=search", pathname: "/jobs/view/4477065882/", origin: "https://www.linkedin.com" },
    document: {
      title: "LinkedIn",
      querySelectorAll(selector) {
        if (selector === ".job-details-jobs-unified-top-card__job-title") return [hiddenOldHeading];
        if (selector === ".job-details-jobs-unified-top-card h2") return [heading];
        if (selector === "a[href*='/company/']") return [company];
        return [];
      },
      querySelector: () => null
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    chrome: { runtime: { onMessage: {
      addListener(callback) { listener = callback; listeners.add(callback); },
      removeListener(callback) { listeners.delete(callback); }
    } } }
  };
  const script = fs.readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8");
  vm.runInNewContext(script, context);
  vm.runInNewContext(script, context);
  assert.equal(listeners.size, 1);
  const response = await new Promise(resolve => listener({ type: "inspectJob" }, null, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.result.title, heading.innerText);
  assert.equal(response.result.companyUrl, "https://www.linkedin.com/company/macquarie-group/");
});

test("reads the job card title instead of the nearby AI heading", async () => {
  let listener;
  const card = {
    innerText: "Macquarie Group\nSenior Full Stack Engineer - Collibra & Governance Technology\nHyderabad, Telangana, India\nApply",
    getClientRects: () => [1],
    parentElement: null
  };
  const company = {
    innerText: "Macquarie Group",
    href: "https://www.linkedin.com/company/macquarie-group/",
    getAttribute: () => "/company/macquarie-group/",
    getClientRects: () => [1],
    parentElement: card
  };
  const context = {
    URL,
    location: { href: "https://www.linkedin.com/jobs/view/4477065882/", pathname: "/jobs/view/4477065882/", origin: "https://www.linkedin.com" },
    document: {
      title: "LinkedIn",
      querySelectorAll: selector => selector === "a[href*='/company/']" ? [company] : selector === "main h2" ? [{ innerText: "Use AI to assess how you fit", getClientRects: () => [1] }] : [],
      querySelector: () => null
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8"), context);
  const response = await new Promise(resolve => listener({ type: "inspectJob" }, null, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.result.title, "Senior Full Stack Engineer - Collibra & Governance Technology");
});

test("skips interns and unknown roles, including immediately before sending", async () => {
  let listener;
  let clicks = 0;
  const personCard = (slug, name, role) => {
    const link = { href: `https://www.linkedin.com/in/${slug}/`, innerText: name };
    const roleElement = role ? { innerText: role, getClientRects: () => [1] } : null;
    const card = {
      innerText: `${name}\n${role || "Connect"}\nConnect`,
      querySelector(selector) {
        if (selector === "a[href*='/in/']") return link;
        if (selector === ".artdeco-entity-lockup__subtitle") return roleElement;
        return null;
      }
    };
    return {
      innerText: "Connect",
      disabled: false,
      getClientRects: () => [1],
      getAttribute: () => `Invite ${name} to connect`,
      closest: () => card,
      click: () => { clicks++; }
    };
  };
  const buttons = [
    personCard("summer-intern", "Sam Intern", "Software Engineering Intern"),
    personCard("engineer", "Alex Engineer", "Senior Software Engineer"),
    personCard("unknown", "Taylor Unknown", "")
  ];
  const context = {
    URL,
    location: { href: "https://www.linkedin.com/company/example/people/", pathname: "/company/example/people/", origin: "https://www.linkedin.com" },
    document: { querySelectorAll: selector => selector === "button" ? buttons : [] },
    getComputedStyle: () => ({ visibility: "visible" }),
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8"), context);
  const call = (type, payload) => new Promise(resolve => listener({ type, payload }, null, resolve));
  const listed = await call("listCandidates");
  assert.equal(listed.ok, true);
  assert.equal(listed.result.length, 1);
  assert.equal(listed.result[0].name, "Alex Engineer");
  const attempted = await call("sendRequest", { person: { key: "https://www.linkedin.com/in/summer-intern/", name: "Sam Intern" }, note: "Hello" });
  assert.equal(attempted.ok, true);
  assert.equal(attempted.result.status, "ineligible");
  const changed = await call("sendRequest", { person: { key: "https://www.linkedin.com/in/engineer/", name: "Alex Engineer", profileUrl: "https://www.linkedin.com/in/engineer/", role: "Engineering Manager" }, note: "Hello" });
  assert.equal(changed.result.status, "ineligible");
  assert.equal(clicks, 0);
});

test("collects post commenters and reactors while excluding interns and unreadable profiles", async () => {
  let listener;
  let modalOpen = false;
  const link = (slug, name) => ({ href: `https://www.linkedin.com/in/${slug}/`, innerText: name });
  const card = (slug, name, role) => ({
    querySelectorAll: selector => selector === "a[href*='/in/']" ? [link(slug, name)] : [],
    querySelector: () => role ? { innerText: role } : null
  });
  const comments = [card("ava", "Ava Example", "Software Engineer"), card("intern", "Ian Intern", "Software Engineering Intern")];
  const reactions = [card("ben", "Ben Example", "Engineering Manager"), card("unknown", "Unknown Role", "")];
  const opener = { innerText: "2 reactions", getAttribute: () => "2 reactions", getClientRects: () => [1], click: () => { modalOpen = true; } };
  const modal = {
    innerText: "Reactions",
    getClientRects: () => [1],
    querySelectorAll: selector => selector.includes("reactor-item") ? reactions : [],
    querySelector: () => ({ scrollTop: 0, clientHeight: 500 })
  };
  const root = {
    querySelectorAll(selector) {
      if (selector.includes("reactions-count")) return [opener];
      if (selector.includes("comments-comment-item")) return comments;
      return [];
    }
  };
  const context = {
    URL,
    setTimeout: callback => callback(),
    location: { href: "https://www.linkedin.com/feed/update/urn:li:activity:12345/", pathname: "/feed/update/urn:li:activity:12345/", origin: "https://www.linkedin.com" },
    document: {
      querySelector: () => root,
      querySelectorAll: selector => selector.includes("artdeco-modal") && modalOpen ? [modal] : []
    },
    getComputedStyle: () => ({ visibility: "visible" }),
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8"), context);
  const response = await new Promise(resolve => listener({ type: "collectPostEngagers" }, null, resolve));
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.result, person => [person.name, person.engagement]), [["Ben Example", "reaction"], ["Ava Example", "comment"]]);
});

test("does not send from a post review when the profile headline has changed", async () => {
  let listener;
  let clicks = 0;
  const top = {
    querySelector: selector => selector.includes("h1") ? { innerText: "Ava Example" } : { innerText: "Engineering Manager" },
    querySelectorAll: () => [{ innerText: "Connect", getClientRects: () => [1], click: () => { clicks++; } }]
  };
  const context = {
    URL,
    location: { href: "https://www.linkedin.com/in/ava/", pathname: "/in/ava/", origin: "https://www.linkedin.com" },
    document: { querySelector: () => top },
    getComputedStyle: () => ({ visibility: "visible" }),
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8"), context);
  const person = { name: "Ava Example", profileUrl: "https://www.linkedin.com/in/ava/", role: "Software Engineer" };
  const response = await new Promise(resolve => listener({ type: "sendProfileRequest", payload: { person, note: "Hello Ava" } }, null, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "ineligible");
  assert.equal(clicks, 0);
});
