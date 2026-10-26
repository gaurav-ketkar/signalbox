const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const localBrowsers = path.resolve(__dirname, "../.local-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fsSync.existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}
const { chromium } = require("playwright");
const core = require("../core.js");
const summaries = require("../summary.js");
const storeApi = require("../store.js");
const fixture = require("./fixtures.cjs");

const extensionPath = path.resolve(__dirname, "..");
const resultsPath = path.join(extensionPath, "test-results");
let context;
let worker;
let extensionId;
let profile;
let page;
let routeState;
let pageErrors = [];

async function eventually(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(message);
}

async function seed(urls = fixture.subscriptions) {
  const records = Object.fromEntries(urls.map((url, index) => {
    const item = core.parseItem(url);
    return [core.STORAGE_PREFIX + item.key, { url: item.url, savedAt: Date.now() + index }];
  }));
  await worker.evaluate(async (values) => chrome.storage.local.set(values), records);
}

async function openFilter() {
  await page.goto("https://github.com/notifications#subscriptions");
  await page.locator("[data-gns-panel]").waitFor();
}

async function complete() {
  await eventually(async () => (await page.locator(".gns-status").textContent()).includes("Inbox search complete"), "Search did not finish");
}

async function openManager(popup = false) {
  const manager = await context.newPage();
  manager.on("pageerror", (error) => pageErrors.push(error.message));
  await manager.goto(`chrome-extension://${extensionId}/manager.html${popup ? "?popup=1" : ""}`);
  await eventually(async () => manager.locator("#add-button").isEnabled(), "Manager did not load storage");
  return manager;
}

async function openNewFilter() {
  await page.getByRole("button", { name: "Customize filters", exact: true }).click();
  await page.getByRole("button", { name: "Create new filter", exact: true }).click();
  const form = page.locator("form[action='/notifications/beta/create_custom_inbox']").last();
  await form.getByRole("button", { name: "Use subscription list", exact: true }).waitFor();
  return form;
}

function previewRequests() {
  return routeState.requests.filter((request) => request.type === "fetch" && core.parseItem(request.url));
}

async function enableSummaries(automatic = false) {
  await worker.evaluate(async ({ key, automatic }) => {
    await chrome.storage.local.set({ [key]: { model: "gemma4:12b-it-qat", automatic } });
  }, { key: summaries.STORAGE_KEY, automatic });
}

async function aiState(updates) {
  return worker.evaluate((values) => {
    if (values) Object.assign(globalThis.gnsTestAI, values);
    return globalThis.gnsTestAI;
  }, updates);
}

async function summarized(count = 4) {
  await eventually(async () => (await page.locator(".gns-ai-summary[data-state='done']").count()) === count, "Local summaries did not finish");
}

async function openDetails(row) {
  const more = row.locator(".gns-more");
  if (await more.getAttribute("aria-expanded") !== "true") await more.click();
  await row.locator(".gns-result-details").waitFor();
}

async function previewToggle(row) {
  await openDetails(row);
  return row.locator(".gns-preview summary");
}

async function recheckButton(target) {
  await openDetails(target.locator(".gns-result").first());
  return target.getByRole("button", { name: "Recheck comment (may mark read)", exact: true });
}

async function openMenu() {
  const menu = page.locator(".gns-menu-button");
  if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
  await page.locator(".gns-menu-panel").waitFor();
}

async function assertRowLayout(expected) {
  const rows = await page.locator(".gns-result").evaluateAll((nodes) => nodes.map((node) => {
    const bounds = (selector) => node.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      row: node.getBoundingClientRect().toJSON(),
      main: bounds(".gns-result-main"),
      title: bounds(".gns-result-link"),
      activity: bounds(".gns-result-activity"),
      aside: bounds(".gns-result-aside"),
      overflow: node.scrollWidth > node.clientWidth
    };
  }));
  assert.ok(rows.length > 0);
  const overlaps = (a, b) => a.width > 0 && b.width > 0 && a.height > 0 && b.height > 0 &&
    a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;
  for (const { row, main, activity, aside, overflow } of rows) {
    assert.equal(overflow, false, "Notification row must not overflow horizontally");
    assert.equal(overlaps(main, activity), false, "Title and summary must not overlap");
    assert.equal(overlaps(main, aside), false, "Row actions must not overlap the title");
    assert.equal(overlaps(activity, aside), false, "Row actions must not overlap the summary");
    assert.ok(aside.right <= row.right + 1, "Row actions must stay inside the row");
    const columns = activity.x >= main.right - 1 && Math.abs(activity.y - main.y) <= 8;
    const stacked = activity.y >= main.bottom - 1;
    assert.ok(columns || stacked, "The summary must sit beside or directly under the title");
    if (expected) assert.ok(expected === "columns" ? columns : stacked, `Expected ${expected} row layout`);
    if (columns) assert.ok(main.width > row.width * 0.25, "The title column must stay readable");
    assert.ok(Math.abs(activity.x - rows[0].activity.x) <= 1, "Summaries must share a scan edge across rows");
  }
}

before(async () => {
  await fs.mkdir(resultsPath, { recursive: true });
  profile = await fs.mkdtemp(path.join(resultsPath, "profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-background-networking"
    ]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
  await context.route("https://github.com/**", async (route) => {
    const url = new URL(route.request().url());
    routeState.requests.push({ url: url.href, method: route.request().method(), type: route.request().resourceType(), referrer: route.request().headers().referer });
    if (url.pathname === "/notifications/beta/archive" && route.request().method() === "POST") {
      const body = route.request().postData() || "";
      routeState.archivedIds = (routeState.archivedIds || []).concat(new URLSearchParams(body).getAll("notification_ids[]"));
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    if (url.pathname === "/notifications/beta/unmark" && route.request().method() === "POST") {
      const body = route.request().postData() || "";
      routeState.unmarkedIds = (routeState.unmarkedIds || []).concat(new URLSearchParams(body).getAll("notification_ids[]"));
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    if (url.pathname === "/notifications") {
      if (routeState.notificationPages) {
        const options = routeState.notificationPages[url.search];
        assert.ok(options, `Unexpected fixture notification page: ${url.search}`);
        await route.fulfill({ contentType: "text/html", body: fixture.notifications(options) });
        return;
      }
      const number = Number(url.searchParams.get("after")?.replace("page-", "") || 1);
      if (number > 1 && routeState.delay) await new Promise((resolve) => setTimeout(resolve, routeState.delay));
      if (number === 2 && routeState.failSecond) {
        await route.fulfill({ status: 429, contentType: "text/html", body: "Try later" });
        return;
      }
      if (number === 2 && routeState.loginSecond) {
        await route.fulfill({ contentType: "text/html", body: '<form action="/session"><input type="password"></form>' });
        return;
      }
      if (number === 2 && routeState.unknownSecond) {
        await route.fulfill({ contentType: "text/html", body: "<main><h1>Something changed</h1></main>" });
        return;
      }
      if (number === 2 && routeState.changedRows) {
        await route.fulfill({ contentType: "text/html", body: '<div class="js-check-all-container"><div class="new-row-format">A notification we cannot identify</div></div>' });
        return;
      }
      const options = {
        page: number,
        modern: routeState.modern,
        empty: routeState.empty,
        ...(routeState.viewer !== undefined ? { viewer: routeState.viewer } : {})
      };
      if (routeState.rows) options.rows = routeState.rows;
      if (routeState.next !== undefined) options.next = routeState.next;
      await route.fulfill({ contentType: "text/html", body: fixture.notifications(options) });
    } else if (route.request().resourceType() === "fetch" && core.parseItem(url.href)) {
      if (routeState.previewDelay) await new Promise((resolve) => setTimeout(resolve, routeState.previewDelay));
      await route.fulfill({
        status: routeState.previewStatus || 200,
        contentType: routeState.previewType || "text/html",
        body: routeState.previewHtml ?? fixture.commentPage({
          id: url.pathname.includes("/discussions/") ? "discussioncomment-789" : "issuecomment-123",
          modern: routeState.modern
        })
      });
    } else {
      await route.fulfill({ contentType: "text/html", body: fixture.itemPage() });
    }
  });
  await context.route("https://evil.test/**", async (route) => {
    routeState.offsiteRequests = (routeState.offsiteRequests || 0) + 1;
    await route.abort();
  });
});

beforeEach(async () => {
  for (const existing of context.pages()) await existing.close();
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
  await worker.evaluate(() => {
    globalThis.gnsOriginalFetch ||= globalThis.fetch;
    globalThis.gnsTestAI = {
      calls: [], delay: 0, active: 0, peak: 0, aborted: 0, tagsStatus: 200, chatStatus: 200,
      models: [{ name: "gemma4:12b-it-qat", size: 7151000000, details: { format: "gguf" }, capabilities: ["completion"] }],
      lmModels: [{ key: "prism-ml/bonsai-27b", type: "llm", format: "mlx", size_bytes: 8521076756, loaded_instances: [{ id: "prism-ml/bonsai-27b" }] }],
      result: { summary: "Keyboard focus now returns to the Save button.", action: "Review the keyboard fix.", response: "fyi", evidence: "" }
    };
    globalThis.gnsOriginalPermissionsContains ||= chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = async (query) => {
      if (query?.origins?.some((o) => o.startsWith("https://api.githubcopilot.com"))) return true;
      return globalThis.gnsOriginalPermissionsContains(query);
    };
    chrome.permissions.request = async () => true;
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!/^(?:http:\/\/127\.0\.0\.1:(11434|1234|8000)|https:\/\/api\.githubcopilot\.com)\//.test(url)) {
        return globalThis.gnsOriginalFetch(input, options);
      }
      const state = globalThis.gnsTestAI;
      const lmStudio = url.startsWith("http://127.0.0.1:1234/");
      const splash = url.startsWith("http://127.0.0.1:8000/");
      const copilot = url.startsWith("https://api.githubcopilot.com/");
      const chat = url.endsWith("/api/chat") || url.endsWith("/v1/chat/completions") || url.endsWith("/chat/completions");
      state.calls.push({ url, method: options.method, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
      options.signal?.throwIfAborted();
      if (chat) {
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (state.delay) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              options.signal?.removeEventListener("abort", cancel);
              resolve();
            }, state.delay);
            function cancel() {
              clearTimeout(timer);
              state.aborted++;
              reject(options.signal.reason);
            }
            options.signal?.addEventListener("abort", cancel, { once: true });
          });
        } finally {
          state.active--;
        }
      }
      const reqBody = options.body ? JSON.parse(options.body) : null;
      const isBriefing = Boolean(reqBody?.format?.properties?.briefing || reqBody?.response_format?.json_schema?.name === "morning_briefing");
      const defaultBriefing = {
        briefing: "Start with @lead-mgr on acme/console#203—she needs your roadmap sign-off today so the team can lock Q4 scope."
      };
      const message = {
        role: "assistant",
        content: state.content ?? JSON.stringify(isBriefing ? (state.briefingResult || defaultBriefing) : state.result)
      };
      if (copilot && chat && state.failCopilotChat) {
        return new Response(JSON.stringify({ error: { message: "Service unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify(chat ? (lmStudio || splash || copilot ?
        { choices: [{ finish_reason: "stop", message }] } :
        { done: true, done_reason: "stop", message }) :
        copilot ? { data: [{ id: "claude-opus-5.5", name: "Claude Opus 5.5", object: "model", capabilities: { type: "chat", limits: { max_context_window_tokens: 1000000 } } }] } :
        splash ? { data: [{ id: "mlx-community/Qwen3.8-27B-4bit", object: "model", context_length: 262144 }] } :
        { models: lmStudio ? state.lmModels : state.models }), {
        status: chat ? state.chatStatus : state.tagsStatus,
        headers: { "Content-Type": "application/json" }
      });
    };
  });
  routeState = { requests: [] };
  pageErrors = [];
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
});

after(async () => {
  if (context) await context.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

test("installs the real MV3 extension and inserts one Subscriptions filter", async () => {
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-filter]").waitFor();
  assert.equal(await page.locator("[data-gns-filter]").count(), 1);
  assert.equal(await page.getByRole("list", { name: "Filters", exact: true }).locator("[data-gns-filter]").count(), 1);
  assert.equal(await page.getByRole("navigation", { name: "Breadcrumbs" }).locator("[data-gns-owned]").count(), 0);
  assert.equal(await page.locator(".notifications-list-item [data-gns-pin]").count(), 5);
  assert.equal(await page.locator(".js-check-all-container").isVisible(), true);
  assert.equal(await page.locator("[data-gns-panel]").count(), 0);
  assert.deepEqual(pageErrors, []);
});

test("creates a named local filter through GitHub's native Create new filter flow", async () => {
  await seed();
  await worker.evaluate(async (key) => chrome.storage.local.set({ [key]: { name: "Subscriptions", enabled: false } }), core.FILTER_STORAGE_KEY);
  await page.goto("https://github.com/notifications");
  const form = await openNewFilter();
  await form.getByRole("button", { name: "Use subscription list" }).click();
  assert.equal(await form.getByRole("textbox", { name: "Filter inbox by..." }).inputValue(), core.FILTER_QUERY);
  await form.getByRole("textbox", { name: "Inbox name" }).fill("Priority subscriptions");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("[data-gns-panel]").waitFor();
  await complete();
  assert.equal(page.url(), "https://github.com/notifications#subscriptions");
  assert.equal(await page.locator(".gns-heading").textContent(), "Priority subscriptions");
  assert.deepEqual(await page.evaluate(() => window.fixtureNativeFilters), []);
  const values = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.deepEqual(values[core.FILTER_STORAGE_KEY], { name: "Priority subscriptions", enabled: true });
  assert.equal(Object.keys(values).filter((key) => key.startsWith(core.STORAGE_PREFIX)).length, fixture.subscriptions.length);
  await page.reload();
  await complete();
  assert.equal(await page.getByRole("list", { name: "Filters", exact: true }).locator("[data-gns-filter]").count(), 1);
  assert.equal(await page.locator(".gns-filter-name").textContent(), "Priority subscriptions");
  assert.ok(routeState.requests.every((request) => request.method === "GET"));
  assert.deepEqual(pageErrors, []);
});

test("accepts the local query with keyboard submission and blocks unsupported combinations", async () => {
  await page.goto("https://github.com/notifications");
  const form = await openNewFilter();
  await form.getByRole("textbox", { name: "Inbox name" }).fill("My subscriptions");
  const query = form.getByRole("textbox", { name: "Filter inbox by..." });
  await query.fill("subscriptions:only reason:mention");
  await query.press("Enter");
  await form.getByRole("alert").waitFor();
  assert.match(await form.getByRole("alert").textContent(), /on its own/);
  assert.deepEqual(await page.evaluate(() => window.fixtureNativeFilters), []);
  assert.deepEqual(await worker.evaluate(async () => chrome.storage.local.get(null)), {});
  await query.fill("subscriptions:only");
  await query.press("Enter");
  await page.locator("[data-gns-panel]").waitFor();
  assert.equal(await page.locator(".gns-heading").textContent(), "My subscriptions");
});

test("leaves ordinary native filter creation and updates untouched", async () => {
  await page.goto("https://github.com/notifications");
  const form = await openNewFilter();
  await form.getByRole("button", { name: "Use subscription list" }).click();
  await form.getByRole("textbox", { name: "Inbox name" }).fill("Assigned");
  await form.getByRole("textbox", { name: "Filter inbox by..." }).fill("reason:assign");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("form[action='/notifications/beta/update_custom_inbox']").getByRole("button", { name: "Update", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixtureNativeFilters), [
    { action: "/notifications/beta/create_custom_inbox", query: "reason:assign" },
    { action: "/notifications/beta/update_custom_inbox", query: "reason:mention" }
  ]);
  assert.deepEqual(await worker.evaluate(async () => chrome.storage.local.get(null)), {});
  assert.equal(await page.locator("[data-gns-panel]").count(), 0);
});

test("renames and hides the local filter across tabs without deleting subscriptions or drafts", async () => {
  await seed();
  await page.goto("https://github.com/notifications");
  await page.getByRole("button", { name: "Customize filters", exact: true }).click();
  const settings = page.locator("[data-gns-filter-settings]");
  const input = settings.getByRole("textbox", { name: "Local filter name" });
  await input.fill("My priority list");
  await settings.getByRole("heading").click();
  await page.evaluate(() => document.dispatchEvent(new Event("turbo:render")));
  await page.waitForTimeout(150);
  assert.equal(await input.inputValue(), "My priority list");
  const second = await context.newPage();
  await second.goto("https://github.com/notifications#subscriptions");
  await second.locator("[data-gns-panel]").waitFor();
  await settings.getByRole("button", { name: "Save local filter" }).click();
  await eventually(async () => (await second.locator(".gns-heading").textContent()) === "My priority list", "Filter name did not update across tabs");
  await settings.getByRole("button", { name: "Hide filter" }).click();
  await eventually(async () => (await second.locator("[data-gns-filter]").count()) === 0, "Filter did not hide in the other tab");
  const values = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(Object.keys(values).filter((key) => key.startsWith(core.STORAGE_PREFIX)).length, fixture.subscriptions.length);
  assert.equal(values[core.FILTER_STORAGE_KEY].enabled, false);
  await page.reload();
  await eventually(async () => (await page.locator("[data-gns-pin]:enabled").count()) > 0, "Storage did not load");
  assert.equal(await page.locator("[data-gns-filter]").count(), 0);
});

test("supports separate desktop and mobile Filters lists but never a global breadcrumb", async () => {
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-filter]").waitFor();
  await page.evaluate(() => {
    const mobile = document.createElement("ul");
    mobile.setAttribute("aria-label", "Filters");
    mobile.className = "mobile-filters";
    document.querySelector("aside").append(mobile);
  });
  await eventually(async () => (await page.locator("[data-gns-filter]").count()) === 2, "Mobile Filters list did not get the shortcut");
  assert.equal(await page.getByRole("navigation", { name: "Breadcrumbs" }).locator("[data-gns-owned]").count(), 0);
});

test("filters across all pages, deduplicates threads, and preserves tracking links", async () => {
  await seed();
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  const titles = await page.locator(".gns-result-title").allTextContents();
  assert.deepEqual(titles, [
    "Tighten the release checklist", "Keep keyboard focus after saving",
    "How should weekly digests work?", "Make notification preferences easier to find"
  ]);
  assert.match(await page.locator(".gns-status").textContent(), /12 notifications checked across 3 pages/);
  assert.match(await page.locator(".gns-result-link").nth(1).getAttribute("href"), /notification_referrer_id=demo#issuecomment-123/);
  assert.equal(await page.locator(".js-check-all-container").isVisible(), false);
  assert.equal(await page.locator(".js-check-all-container").evaluate((node) => node.inert), true);
  assert.equal(await page.locator(".paginate-container").isVisible(), false);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  assert.ok(routeState.requests.every((request) => request.method === "GET"));
  assert.equal(routeState.requests.filter((request) => request.url.includes("after=")).length, 2);
  assert.deepEqual(pageErrors, []);
});

test("keeps reasons, participants, item states, read status, and dates across every page", async () => {
  await seed();
  await openFilter();
  await complete();
  assert.deepEqual(await page.locator(".gns-reason").allTextContents(), [
    "assign", "mention", "subscribed", "team mention"
  ]);
  assert.equal(await page.locator(".gns-reason").nth(1).getAttribute("title"), "You were mentioned");
  assert.deepEqual(await page.locator(".gns-item-state").allTextContents(), ["Open", "Merged", "Closed"]);
  assert.deepEqual(await page.locator(".gns-participants").allTextContents(), [
    "@maya, @sam", "@ada", "@morgan", "@jules"
  ]);
  assert.deepEqual(await page.locator(".gns-result").evaluateAll((rows) => rows.map((row) => row.dataset.unread)), ["true", "true", "false", "true"]);
  assert.equal(await page.locator(".gns-time[datetime]").count(), 4);
  for (const text of await page.locator(".gns-time").allTextContents()) {
    assert.match(text, /^(just now|\d+ (min|hr|days|wk) ago|yesterday|[A-Z][a-z]{2} \d+(, \d{4})?)$/);
  }
  assert.deepEqual(await page.locator(".gns-kind").evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ["issue", "pull", "discussion", "issue"]);
  assert.match(await page.locator(".gns-result-number").first().textContent(), /^#\d+$/);
  assert.equal(await page.locator(".gns-menu-panel").isVisible(), false);
  await openMenu();
  assert.equal(await page.locator(".gns-menu-panel .gns-status").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".gns-menu-panel").isVisible(), false);
  assert.equal(previewRequests().length, 0);
});

test("expands repository groups and all their pages without dropping matches or native reasons", async () => {
  const first = "?query=repo%3Aacme%2Fconsole";
  const next = first + "&after=page-2";
  const second = "?query=repo%3Aacme%2Fother";
  routeState.notificationPages = {
    "": {
      rows: [fixture.pages[0][0]], next: null,
      groups: [{ href: first, count: 3 }, { href: first, count: 3 }, { href: second, count: 1 }]
    },
    [first]: { rows: [fixture.pages[0][0], fixture.pages[0][2]], next },
    [next]: { rows: [fixture.pages[1][0]], next: null },
    [second]: { rows: [{ ...fixture.pages[2][0], href: "/acme/other/issues/84", reason: "commented" }], next: null }
  };
  await seed([...fixture.subscriptions, "https://github.com/acme/other/issues/84"]);
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  assert.match(await page.locator(".gns-status").textContent(), /5 notifications checked across 4 pages/);
  assert.equal(await page.locator(".gns-reason").last().textContent(), "commented");
  assert.deepEqual(routeState.requests.map((request) => new URL(request.url).search), ["", first, next, second]);
  assert.equal(await page.locator(".js-notifications-group-view-all").first().isVisible(), false);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  assert.deepEqual(pageErrors, []);
});

test("stops visibly for unsafe or unreadable repository-group links", async () => {
  await seed();
  for (const href of ["https://evil.test/notifications", "/logout", null]) {
    routeState.notificationPages = {
      "": { rows: [fixture.pages[0][0]], next: null, groups: [{ href, count: 20 }] }
    };
    await page.goto("about:blank");
    await openFilter();
    await page.locator(".gns-error").waitFor({ state: "visible" });
    assert.match(await page.locator(".gns-error").textContent(), href ? /unexpected repository-group link/ : /View all link was not recognized/);
    assert.doesNotMatch(await page.locator(".gns-status").textContent(), /search complete/);
  }
  assert.equal(routeState.offsiteRequests || 0, 0);
  assert.ok(routeState.requests.every((request) => new URL(request.url).pathname === "/notifications"));
});

test("fetches only the exact linked comment on demand and caches it until Refresh", async () => {
  await seed();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  const summary = await previewToggle(row);
  assert.equal(previewRequests().length, 0);
  await summary.click();
  await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes("keyboard fix"), "Exact comment did not load");
  assert.match(await row.locator(".gns-preview-meta").textContent(), /^ada/);
  assert.doesNotMatch(await row.locator(".gns-preview-text").textContent(), /older|newer/);
  assert.equal(previewRequests().length, 1);
  assert.equal(previewRequests()[0].url, "https://github.com/acme/console/pull/42");
  assert.equal(previewRequests()[0].referrer, undefined);
  assert.match(await row.locator(".gns-preview .gns-text-link").getAttribute("href"), /notification_referrer_id=demo#issuecomment-123$/);
  await summary.click();
  await summary.click();
  assert.equal(previewRequests().length, 1);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  assert.deepEqual(pageErrors, []);
});

test("shows an honest explanation without fetching when no comment link was supplied", async () => {
  await seed();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").first();
  await (await previewToggle(row)).click();
  assert.match(await row.locator(".gns-preview-status").textContent(), /did not include/);
  assert.equal(previewRequests().length, 0);
});

test("never substitutes a newer comment for a missing or ambiguous linked comment", async () => {
  await seed();
  await openFilter();
  await complete();
  let requests = 0;
  for (const html of [
    fixture.commentPage({ missing: true }),
    '<main><div class="TimelineItem"><a id="issuecomment-123"></a><div class="comment-body">Wrong first comment</div><div class="comment-body">Wrong second comment</div></div></main>'
  ]) {
    routeState.previewHtml = html;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await complete();
    const row = page.locator(".gns-result").nth(1);
    await (await previewToggle(row)).click();
    await eventually(async () => (await row.locator(".gns-preview-status").textContent()).includes("not in GitHub"), "Missing exact comment did not produce a clear explanation");
    assert.equal(await row.locator(".gns-preview-text").textContent(), "");
    assert.equal(previewRequests().length, ++requests);
  }
});

test("previews modern discussion comments and supported review or commit fragments", async () => {
  await seed();
  routeState.modern = true;
  await openFilter();
  await complete();
  const discussion = page.locator(".gns-result").nth(2);
  await (await previewToggle(discussion)).click();
  await eventually(async () => (await discussion.locator(".gns-preview-text").textContent()).includes("keyboard fix"), "Modern discussion comment did not load");
  for (const fragment of ["pullrequestreview-123", "discussion_r123", "r123", "commitcomment-123"]) {
    routeState.rows = [{ href: `/acme/console/pull/42#${fragment}`, title: fragment, unread: true }];
    routeState.next = null;
    routeState.previewHtml = fixture.commentPage({ id: fragment });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await complete();
    const row = page.locator(".gns-result").first();
    await (await previewToggle(row)).click();
    await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes("keyboard fix"), `${fragment} did not load`);
  }
});

test("renders preview content as safe text without scripts, forms, or remote images", async () => {
  routeState.previewHtml = fixture.commentPage({
    body: '<p>Useful comment</p><script>window.previewInjected=true</script><form>Hidden form<input value="secret"></form><img src="https://evil.test/track" alt="diagram" onerror="window.previewInjected=true"><iframe src="https://evil.test/frame"></iframe><p>&lt;img onerror=evil&gt;</p><pre>const safe = true;</pre>'
  });
  await seed();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await (await previewToggle(row)).click();
  await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes("Useful comment"), "Preview did not render");
  const text = await row.locator(".gns-preview-text").textContent();
  assert.match(text, /\[Image: diagram\]/);
  assert.match(text, /<img onerror=evil>/);
  assert.match(text, /const safe = true/);
  assert.doesNotMatch(text, /previewInjected|Hidden form|secret/);
  assert.equal(await row.locator(".gns-preview img, .gns-preview script, .gns-preview form, .gns-preview iframe").count(), 0);
  assert.equal(await page.evaluate(() => window.previewInjected), undefined);
  assert.equal(routeState.offsiteRequests || 0, 0);
});

test("preview failures can retry without making a complete inbox search look incomplete", async () => {
  routeState.previewStatus = 429;
  await seed();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await (await previewToggle(row)).click();
  await row.getByRole("button", { name: "Retry preview" }).waitFor({ state: "visible" });
  assert.match(await row.locator(".gns-preview-status").textContent(), /rate-limited/);
  assert.match(await page.locator(".gns-status").textContent(), /Inbox search complete/);
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  routeState.previewStatus = 200;
  await row.getByRole("button", { name: "Retry preview" }).click();
  await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes("keyboard fix"), "Retry did not load the preview");
  assert.equal(previewRequests().length, 2);
});

test("closing or removing a row cancels its preview without stale results or errors", async () => {
  routeState.previewDelay = 500;
  await seed();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await (await previewToggle(row)).click();
  await eventually(() => previewRequests().length === 1, "Preview did not begin");
  await (await previewToggle(row)).click();
  assert.equal(await row.locator(".gns-preview-text").textContent(), "");
  await (await previewToggle(row)).click();
  await eventually(() => previewRequests().length === 2, "Reopened preview did not restart");
  await openDetails(row);
  await row.locator("[data-gns-pin]").click();
  await eventually(async () => (await page.locator(".gns-result").count()) === 3, "Unsubscribed row was not removed");
  await page.waitForTimeout(650);
  assert.equal(await page.locator(".gns-preview-text").filter({ hasText: "keyboard fix" }).count(), 0);
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  assert.deepEqual(pageErrors, []);
});

test("does not invent a reason from an item title or participant name", async () => {
  routeState.rows = [{ href: "/acme/console/issues/11", title: "mention", unread: true, participants: ["author"] }];
  routeState.next = null;
  await seed();
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-reason").count(), 0);
  assert.equal(await page.locator(".gns-participants").textContent(), "@author");
});

test("uses an explicit empty state and makes no extra requests for an empty list", async () => {
  await openFilter();
  await page.getByRole("heading", { name: "Choose what belongs here" }).waitFor();
  assert.equal(await page.locator(".gns-result").count(), 0);
  assert.equal(routeState.requests.filter((request) => request.url.includes("after=")).length, 0);
  assert.equal(await page.getByRole("button", { name: "Add subscriptions" }).isVisible(), true);
});

test("restores the untouched native inbox and its selection when the filter is off", async () => {
  await seed();
  await openFilter();
  await complete();
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await eventually(async () => (await page.locator("[data-gns-panel]").count()) === 0, "Filtered view remained mounted");
  assert.equal(await page.locator(".js-check-all-container").isVisible(), true);
  assert.equal(await page.locator(".js-check-all-container").evaluate((node) => node.inert), false);
  assert.equal(await page.locator(".notifications-list-item").count(), 6);
  assert.equal(await page.locator("[data-gns-native-hidden]").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Inbox", exact: true }).getAttribute("aria-current"), "page");
});

test("does not overwrite GitHub's new selection after navigating to Done", async () => {
  await seed();
  await openFilter();
  await complete();
  await page.evaluate(() => {
    history.pushState({}, "", "/notifications?query=is%3Adone");
    const done = [...document.querySelectorAll("nav a")].find((node) => node.textContent === "Done");
    done.setAttribute("aria-current", "page");
    done.classList.add("selected");
    document.dispatchEvent(new Event("turbo:load"));
  });
  await eventually(async () => (await page.locator("[data-gns-panel]").count()) === 0, "The filter was not removed");
  assert.equal(await page.getByRole("link", { name: "Done", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("link", { name: "Inbox", exact: true }).getAttribute("aria-current"), null);
});

test("adds and removes an item from its GitHub page without changing GitHub", async () => {
  await page.goto("https://github.com/acme/console/issues/11");
  const pin = page.locator("[data-gns-item-tools] [data-gns-pin]");
  await pin.waitFor();
  await eventually(() => pin.isEnabled(), "Pin is not ready");
  await pin.click();
  await eventually(async () => (await pin.getAttribute("aria-pressed")) === "true", "Pin was not saved");
  const saved = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(Object.keys(saved).length, 1);
  await pin.click();
  await eventually(async () => (await pin.getAttribute("aria-pressed")) === "false", "Pin was not removed");
  assert.deepEqual(await worker.evaluate(async () => chrome.storage.local.get(null)), {});
  assert.ok(routeState.requests.every((request) => request.method === "GET"));
});

test("notification-row bookmarks do not navigate or invoke native actions", async () => {
  await page.goto("https://github.com/notifications");
  const pin = page.locator(".notifications-list-item [data-gns-pin]").first();
  await pin.waitFor();
  await eventually(() => pin.isEnabled(), "Pin is not ready");
  await pin.click();
  await eventually(async () => (await pin.getAttribute("aria-pressed")) === "true", "Pin was not saved");
  assert.equal(page.url(), "https://github.com/notifications");
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
});

test("manager validates whole batches, handles duplicates, searches, exports, and persists", async () => {
  const manager = await openManager();
  await manager.locator("#links").fill("acme/console#11\nhttps://evil.test/owner/repo/issues/1");
  await manager.locator("#add-button").click();
  await manager.locator("#error").waitFor({ state: "visible" });
  assert.match(await manager.locator("#error").textContent(), /Nothing was added/);
  assert.deepEqual(await worker.evaluate(async () => chrome.storage.local.get(null)), {});
  await manager.locator("#links").fill("acme/console#11\nhttps://github.com/acme/console/pull/11\nhttps://github.com/acme/console/discussions/73");
  await manager.locator("#add-button").click();
  await eventually(async () => (await manager.locator(".saved-item").count()) === 2, "Manager did not save both unique items");
  assert.equal(await manager.locator("#links").inputValue(), "");
  await manager.locator("#search").fill("discussion");
  assert.equal(await manager.locator(".saved-item").count(), 1);
  await manager.locator("#search").fill("");
  const downloadPromise = manager.waitForEvent("download");
  await manager.locator("#export").click();
  const download = await downloadPromise;
  const exportPath = path.join(resultsPath, "github-subscriptions.txt");
  await download.saveAs(exportPath);
  const exported = await fs.readFile(exportPath, "utf8");
  assert.equal(core.parseInput(exported).items.length, 2);
  await fs.unlink(exportPath);
  await manager.reload();
  await eventually(async () => (await manager.locator(".saved-item").count()) === 2, "Saved items did not persist");
  await manager.locator(".remove-button").first().click();
  await eventually(async () => (await manager.locator(".saved-item").count()) === 1, "Remove did not work");
  assert.deepEqual(pageErrors, []);
});

test("storage updates in another tab immediately update a completed filtered view", async () => {
  await seed();
  await openFilter();
  await complete();
  const manager = await openManager();
  await manager.getByRole("button", { name: "Remove acme/console#11 from subscriptions", exact: true }).click();
  await eventually(async () => (await page.locator(".gns-result").count()) === 3, "Removal was not reflected in the inbox");
  await manager.locator("#links").fill("acme/console#999");
  await manager.locator("#add-button").click();
  await eventually(async () => (await page.locator(".gns-result-title").allTextContents()).includes("An unrelated issue"), "New subscription did not match a previously scanned page");
});

test("opening an empty filter starts scanning after the first subscription is added", async () => {
  await openFilter();
  await page.getByRole("heading", { name: "Choose what belongs here" }).waitFor();
  await seed(["https://github.com/acme/console/issues/84"]);
  await complete();
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), ["Make notification preferences easier to find"]);
});

test("a rate-limit error is visible and Retry resumes the missing page", async () => {
  routeState.failSecond = true;
  await seed();
  await openFilter();
  await page.locator(".gns-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".gns-error").textContent(), /rate-limited/);
  assert.match(await page.locator(".gns-status").textContent(), /Search incomplete/);
  assert.equal(await page.locator(".gns-result").count(), 2);
  routeState.failSecond = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  assert.equal(routeState.requests.filter((request) => request.url.includes("after=page-2")).length, 2);
});

test("login HTML is not mistaken for an empty or completed search", async () => {
  routeState.loginSecond = true;
  await seed();
  await openFilter();
  await page.locator(".gns-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".gns-error").textContent(), /sign in/);
  assert.doesNotMatch(await page.locator(".gns-status").textContent(), /search complete/);
});

test("unrecognized HTML is surfaced instead of claiming there are no matches", async () => {
  routeState.unknownSecond = true;
  await seed();
  await openFilter();
  await page.locator(".gns-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".gns-error").textContent(), /not recognized/);
});

test("a familiar wrapper with unrecognized rows must not count as an empty page", async () => {
  routeState.changedRows = true;
  await seed();
  await openFilter();
  await page.locator(".gns-error").waitFor({ state: "visible", timeout: 5000 });
  assert.match(await page.locator(".gns-error").textContent(), /not recognized/);
  assert.doesNotMatch(await page.locator(".gns-status").textContent(), /search complete/);
});

test("an enabled next-page button without a readable link must not truncate the scan", async () => {
  await seed();
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-filter]").waitFor();
  await page.evaluate(() => {
    document.querySelector(".paginate-container").innerHTML = '<button aria-label="Next">Next</button>';
    location.hash = "subscriptions";
  });
  await page.locator(".gns-error").waitFor({ state: "visible", timeout: 5000 });
  assert.match(await page.locator(".gns-error").textContent(), /next-page/i);
});

test("a changed outer wrapper still hides every native notification group", async () => {
  await seed();
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-filter]").waitFor();
  await page.evaluate(() => {
    document.querySelector(".js-check-all-container").className = "new-outer-wrapper";
    document.querySelector("main").append(document.querySelector(".Box").cloneNode(true));
    location.hash = "subscriptions";
  });
  await page.locator("[data-gns-panel]").waitFor();
  await complete();
  assert.equal(await page.locator(".notifications-list-item").evaluateAll((nodes) =>
    nodes.filter((node) => node.getBoundingClientRect().height > 0).length), 0);
});

test("finds the Inbox link in a div-based sidebar without matching the global bell", async () => {
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-filter]").waitFor();
  await page.evaluate(() => {
    document.querySelectorAll("[data-gns-owned]").forEach((node) => node.remove());
    const sidebar = document.createElement("div");
    sidebar.className = "SideNav";
    sidebar.innerHTML = '<a href="/notifications">Inbox</a><a href="/notifications?query=is%3Adone">Done</a>';
    document.querySelector("aside").replaceWith(sidebar);
    const bell = document.createElement("a");
    bell.href = "/notifications";
    bell.textContent = "Global notifications bell";
    document.body.prepend(bell);
  });
  await page.locator(".SideNav [data-gns-filter]").waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-gns-filter]").count(), 1);
});

test("a failed list reload never clears input or reports a successful add", async () => {
  const manager = await openManager();
  await manager.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (values) => {
      await originalSet(values);
      chrome.storage.local.get = async () => { throw new Error("Storage read failed"); };
    };
  });
  await manager.locator("#links").fill("acme/console#11");
  await manager.locator("#add-button").click();
  await manager.locator("#error").waitFor({ state: "visible" });
  assert.match(await manager.locator("#error").textContent(), /Storage read failed/);
  assert.equal(await manager.locator("#status").textContent(), "");
  assert.equal(await manager.locator("#links").inputValue(), "acme/console#11");
});

test("rejects external pagination before making an offsite request", async () => {
  routeState.next = "https://evil.test/notifications";
  await seed();
  await openFilter();
  await page.locator(".gns-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".gns-error").textContent(), /unexpected next-page link/);
});

test("Pause and Continue preserve progress without duplicating results", async () => {
  routeState.delay = 800;
  await seed();
  await openFilter();
  await eventually(async () => (await page.locator(".gns-result").count()) === 2, "First page was not rendered");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await eventually(async () => (await page.locator(".gns-status").textContent()).includes("Search paused"), "Search did not pause");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
});

test("Refresh rereads the first page instead of reusing stale DOM", async () => {
  await seed();
  await openFilter();
  await complete();
  routeState.rows = [{ href: "/acme/console/issues/84", title: "An updated notification", unread: true }];
  routeState.next = null;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), ["An updated notification"]);
  assert.equal(routeState.requests.filter((request) => new URL(request.url).pathname === "/notifications" && !new URL(request.url).search).length, 2);
});

test("reuses a recent inbox search across page loads until Refresh or it goes stale", async () => {
  await seed();
  await openFilter();
  await complete();
  const pageFetches = () => routeState.requests.filter((request) => request.url.includes("after=")).length;
  const fetched = pageFetches();
  assert.ok(fetched > 0);
  await page.reload();
  await page.locator("[data-gns-panel]").waitFor();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  assert.equal(pageFetches(), fetched, "A fresh cached search should not refetch inbox pages");
  assert.match(await page.locator(".gns-status").textContent(), /Last checked just now/);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  assert.equal(pageFetches(), fetched * 2, "Refresh should search every page again");

  await worker.evaluate(async () => {
    const values = await chrome.storage.session.get(null);
    for (const value of Object.values(values)) value.checkedAt -= 11 * 60 * 1000;
    await chrome.storage.session.set(values);
  });
  await page.reload();
  await page.locator("[data-gns-panel]").waitFor();
  await complete();
  assert.equal(pageFetches(), fetched * 3, "A stale cached search should be refreshed");
  assert.deepEqual(pageErrors, []);
});

test("shows reason and participants under the title without leaving the title column", async () => {
  await seed();
  await openFilter();
  await complete();
  const boxes = await page.locator(".gns-result").first().evaluate((row) => {
    const rect = (selector) => row.querySelector(selector).getBoundingClientRect().toJSON();
    return { title: rect(".gns-result-link"), signals: rect(".gns-signals"), main: rect(".gns-result-main"), activity: rect(".gns-result-activity") };
  });
  assert.ok(boxes.signals.top >= boxes.title.bottom - 1, "Signals should sit below the title");
  assert.ok(Math.abs(boxes.signals.left - boxes.title.left) <= 1, "Signals should align with the title");
  assert.ok(boxes.signals.right <= boxes.activity.left, "Signals should stay out of the summary column");
  assert.equal(await page.locator(".gns-result").first().locator(".gns-participants").getAttribute("title"), "Participants: @maya, @sam");
});

test("a bookmarked filter URL with a native query still searches the full inbox", async () => {
  await seed();
  await page.goto("https://github.com/notifications?query=is%3Aunread#subscriptions");
  await page.locator("[data-gns-panel]").waitFor();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  assert.ok(routeState.requests.some((request) => request.url === "https://github.com/notifications"));
});

test("handles supported alternate row markup and an empty GitHub inbox", async () => {
  routeState.modern = true;
  await seed();
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 4);
  routeState.empty = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 0);
  assert.equal(await page.getByRole("heading", { name: "No matching inbox notifications" }).isVisible(), true);
});

test("treats notification titles as text, never executable HTML", async () => {
  routeState.rows = [{ href: "/acme/console/issues/11", title: '<img src=x onerror="window.injected=true">', unread: true }];
  routeState.next = null;
  await seed();
  await openFilter();
  await complete();
  assert.match(await page.locator(".gns-result-title").textContent(), /<img/);
  assert.equal(await page.locator(".gns-result img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
});

test("reconciles Turbo navigation and dynamic rows without duplicate controls", async () => {
  await page.goto("https://github.com/acme/console/issues/11");
  await page.locator("[data-gns-item-tools]").waitFor();
  await page.evaluate((html) => {
    history.pushState({}, "", "/notifications");
    const replacement = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...replacement.body.childNodes);
    document.dispatchEvent(new Event("turbo:load"));
  }, fixture.notifications());
  await page.locator("[data-gns-filter]").waitFor();
  assert.equal(await page.locator("[data-gns-item-tools]").count(), 0);
  await page.evaluate((html) => {
    document.querySelector(".notifications-list").insertAdjacentHTML("beforeend", html);
    document.dispatchEvent(new Event("turbo:render"));
  }, fixture.row({ href: "/acme/console/pull/555", title: "Added by a live update", unread: true }, 555));
  await eventually(async () => (await page.locator("[data-gns-pin='acme/console#555']").count()) === 1, "Dynamic row did not get a pin");
  assert.equal(await page.locator("[data-gns-filter]").count(), 1);
  assert.deepEqual(pageErrors, []);
});

test("manager opens from the injected controls via the service worker", async () => {
  await seed();
  await openFilter();
  const newPage = context.waitForEvent("page");
  await page.getByRole("button", { name: "Manage list", exact: true }).click();
  const manager = await newPage;
  await manager.waitForURL(`chrome-extension://${extensionId}/manager.html`);
  await manager.getByRole("heading", { name: "Subscriptions", exact: true }).waitFor();
});

test("local summaries stay off until configured and requested", async () => {
  await seed();
  await openFilter();
  await complete();
  assert.equal(await page.getByRole("button", { name: "Set up local summaries", exact: true }).isVisible(), true);
  assert.equal(await page.locator(".gns-ai-summary:visible").count(), 0);
  assert.equal(previewRequests().length, 0);
  assert.deepEqual((await aiState()).calls, []);
  assert.deepEqual(await worker.evaluate(async (key) => chrome.storage.local.get(key), summaries.STORAGE_KEY), {});
});

test("configures a local model and saves summaries without storing full source comments", async () => {
  await seed();
  const manager = await openManager();
  await manager.locator("#summary-server").selectOption("ollama");
  await manager.getByRole("button", { name: "Connect to local server", exact: true }).click();
  await eventually(async () => manager.locator("#save-summary-settings").isEnabled(), "Local model discovery did not finish");
  assert.equal(await manager.locator("#summary-model").inputValue(), "gemma4:12b-it-qat");
  assert.equal(await manager.locator("#summary-automatic").isChecked(), false);
  await manager.locator("#save-summary-settings").click();
  await eventually(async () => (await manager.locator("#summary-status").textContent()).includes("Saved"), "Model settings were not saved");
  await openFilter();
  await complete();
  assert.equal(previewRequests().length, 0);
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(4);
  assert.equal(previewRequests().length, 4);
  const state = await aiState();
  const calls = state.calls.filter((call) => call.url.endsWith("/api/chat"));
  assert.equal(calls.length, 4);
  assert.ok(state.peak >= 1 && state.peak <= 4);
  for (const call of calls) {
    const source = call.body.messages.find((message) => message.role === "user").content;
    assert.doesNotMatch(source, /notification_referrer_id/);
  }
  const row = page.locator(".gns-result").nth(1);
  assert.match(await row.locator(".gns-ai-text").textContent(), /Keyboard focus/);
  assert.match(await row.locator(".gns-ai-action").textContent(), /Review/);
  assert.equal(await row.locator(".gns-reason").textContent(), "mention");
  await (await previewToggle(row)).click();
  await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes("keyboard fix"), "Original comment was not retained");
  assert.equal(previewRequests().length, 4);
  const saved = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.deepEqual(saved[summaries.STORAGE_KEY], { model: "gemma4:12b-it-qat", automatic: false });
  assert.equal(Object.keys(saved).filter((key) => key.startsWith(storeApi.CACHE_PREFIX)).length, 4);
  assert.doesNotMatch(JSON.stringify(saved), /@you, could you review the keyboard fix\?|Focus now returns/);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  assert.deepEqual(pageErrors, []);
});

test("manual summary batches start higher-priority notifications before earlier low-priority rows", async () => {
  await seed();
  await enableSummaries();
  const dateTime = new Date().toISOString();
  routeState.rows = [
    { ...fixture.pages[0][0], reason: "subscribed", reasonTitle: "You are subscribed to this thread", dateTime },
    { ...fixture.pages[0][2], reason: "mention", icon: "octicon-issue-opened", dateTime }
  ];
  routeState.next = null;
  await aiState({ delay: 150 });
  await openFilter();
  await complete();
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), [
    "Tighten the release checklist", "Keep keyboard focus after saving"
  ]);
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(2);
  const requests = previewRequests();
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/pull\/42/);
  assert.match(requests[1].url, /\/issues\/11/);
  assert.ok((await aiState()).peak >= 2, "Priority scheduling must preserve parallel processing");
  assert.deepEqual(pageErrors, []);
});

test("falls back to summarizing available issue and timeline content when an exact linked comment is missing", async () => {
  await seed();
  await enableSummaries();
  routeState.previewHtml = fixture.commentPage({ missing: true });
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-result .gns-ai-start").count(), 4);
  const row = page.locator(".gns-result").nth(1);
  await row.getByRole("button", { name: "Summarize", exact: true }).click();
  await summarized(1);
  assert.equal(await row.locator(".gns-ai-summary").getAttribute("data-state"), "done");
  assert.doesNotMatch(await row.locator(".gns-ai-status").textContent(), /exact linked comment is unavailable/i);
  assert.match(await row.locator(".gns-ai-text").textContent(), /Keyboard focus/);
  assert.match(await page.locator(".gns-status").textContent(), /Inbox search complete/);
});

test("LM Studio setup selects its own local endpoint and never silently switches providers", async () => {
  await seed();
  const manager = await openManager();
  await manager.locator("#summary-server").selectOption("lmstudio");
  await manager.locator("#connect-models").click();
  await eventually(async () => manager.locator("#save-summary-settings").isEnabled(), "LM Studio models did not load");
  assert.equal(await manager.locator("#summary-model").inputValue(), "lmstudio:prism-ml/bonsai-27b");
  await manager.locator("#summary-automatic").check();
  await manager.locator("#save-summary-settings").click();
  await eventually(async () => (await manager.locator("#summary-status").textContent()).startsWith("Saved"), "LM Studio settings were not saved");
  await openFilter();
  await complete();
  await summarized(4);
  const calls = (await aiState()).calls;
  assert.ok(calls.every((call) => call.url.startsWith("http://127.0.0.1:1234/")));
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/chat/completions")).length, 4);
  await manager.locator("#summary-server").selectOption("ollama");
  assert.equal(await manager.locator("#summary-model").inputValue(), "");
  assert.equal(await manager.locator("#save-summary-settings").isEnabled(), false);
  const saved = await worker.evaluate(async (key) => chrome.storage.local.get(key), summaries.STORAGE_KEY);
  assert.equal(saved[summaries.STORAGE_KEY].model, "lmstudio:prism-ml/bonsai-27b");
  assert.deepEqual(pageErrors, []);
});

test("Splash is the setup default and saved provider choices are preserved", async () => {
  await seed();
  const manager = await openManager();
  assert.equal(await manager.locator("#summary-server").inputValue(), "splash");
  await manager.locator("#connect-models").click();
  await eventually(async () => manager.locator("#save-summary-settings").isEnabled(), "Splash models did not load");
  assert.equal(await manager.locator("#summary-model").inputValue(), "splash:mlx-community/Qwen3.8-27B-4bit");
  await manager.locator("#summary-automatic").check();
  await manager.locator("#save-summary-settings").click();
  await eventually(async () => (await manager.locator("#summary-status").textContent()).startsWith("Saved"), "Splash settings were not saved");
  await openFilter();
  await complete();
  await summarized(4);
  const calls = (await aiState()).calls;
  assert.ok(calls.every((call) => call.url.startsWith("http://127.0.0.1:8000/")));
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/chat/completions")).length, 4);
  await manager.reload();
  await eventually(async () => manager.locator("#connect-models").isEnabled(), "Saved settings did not load");
  assert.equal(await manager.locator("#summary-server").inputValue(), "splash");
  assert.deepEqual(pageErrors, []);
});

test("Local MLX selection survives control updates instead of resetting to Ollama", async () => {
  await seed();
  const manager = await openManager();
  await manager.locator("#summary-server").selectOption("mlx");
  assert.equal(await manager.locator("#summary-server").inputValue(), "mlx");
  assert.equal(await manager.locator("#summary-model").inputValue(), "");
  assert.equal(await manager.locator("#save-summary-settings").isEnabled(), false);
  assert.deepEqual(pageErrors, []);
});

test("an unavailable local model stops summaries before fetching GitHub comments", async () => {
  await seed();
  await enableSummaries(true);
  await aiState({ tagsStatus: 403 });
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await row.getByRole("button", { name: "Retry summary", exact: true }).waitFor();
  assert.equal(previewRequests().length, 0);
  const before = (await aiState()).calls.length;
  await page.waitForTimeout(250);
  assert.equal((await aiState()).calls.length, before);
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  await aiState({ tagsStatus: 200 });
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized();
});

test("summary failures retry separately and model output is always rendered as text", async () => {
  await seed();
  await enableSummaries();
  await aiState({ content: "not a JSON summary" });
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await row.getByRole("button", { name: "Summarize", exact: true }).click();
  await row.getByRole("button", { name: "Retry summary", exact: true }).waitFor();
  assert.equal(await row.locator(".gns-ai-text").textContent(), "");
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  await aiState({
    content: null,
    result: { summary: '<img src="https://evil.test/summary" onerror="window.summaryInjected=true"> is source text.', action: "", response: "fyi", evidence: "" }
  });
  await row.getByRole("button", { name: "Retry summary", exact: true }).click();
  await summarized(1);
  assert.match(await row.locator(".gns-ai-text").textContent(), /<img/);
  assert.equal(await row.locator(".gns-ai-summary img, .gns-ai-summary script").count(), 0);
  assert.equal(await row.locator(".gns-ai-action").textContent(), "");
  assert.equal(await page.evaluate(() => window.summaryInjected), undefined);
  assert.equal(previewRequests().length, 1);
  assert.equal(routeState.offsiteRequests || 0, 0);
});

test("shortened source comments are explicitly labeled in AI summaries", async () => {
  await seed();
  await enableSummaries();
  routeState.previewHtml = fixture.commentPage({ body: `<p>${"Long source sentence. ".repeat(800)}</p>` });
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  await row.getByRole("button", { name: "Summarize", exact: true }).click();
  await summarized(1);
  assert.match(await row.locator(".gns-ai-caution").textContent(), /shortened comment/);
  const input = (await aiState()).calls.find((call) => call.url.endsWith("/api/chat")).body.messages.find((message) => message.role === "user").content;
  assert.ok(input.length < 13000);
  assert.match(input, /true|shortened|partial|truncated/i);
});

test("stopping and removing notifications cancel local inference without stale results", async () => {
  await seed();
  await enableSummaries(true);
  await aiState({ delay: 900 });
  await openFilter();
  await complete();
  await eventually(async () => (await aiState()).active >= 1, "Local inference did not start");
  await page.getByRole("button", { name: "Stop summaries", exact: true }).click();
  await eventually(async () => (await aiState()).active === 0 && (await aiState()).aborted >= 1, "Stopping did not cancel local inference");
  const abortedBefore = (await aiState()).aborted;
  assert.equal(await page.locator(".gns-ai-summary[data-state='done']").count(), 0);
  const row = page.locator(".gns-result").nth(1);
  await row.getByRole("button", { name: "Summarize", exact: true }).click();
  await eventually(async () => (await aiState()).active === 1, "Local inference did not restart");
  await openDetails(row);
  await row.locator("[data-gns-pin]").click();
  await eventually(async () => (await aiState()).aborted === abortedBefore + 1, "Removing the subscription did not cancel inference");
  await page.waitForTimeout(950);
  assert.equal(await page.locator(".gns-ai-summary[data-state='done']").count(), 0);
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  assert.deepEqual(pageErrors, []);
});

test("automatic summaries run in parallel within the context window across tabs and clear when turned off", async () => {
  await seed();
  await enableSummaries(true);
  await aiState({ delay: 120 });
  await openFilter();
  const other = await context.newPage();
  await other.goto("https://github.com/notifications#subscriptions");
  await complete();
  await summarized(4);
  await eventually(async () => (await other.locator(".gns-ai-summary[data-state='done']").count()) === 4, "Second tab summaries did not finish");
  assert.ok((await aiState()).peak >= 2, "Expected parallel inference within the model context window");
  const manager = await openManager();
  await manager.getByRole("button", { name: "Turn off summaries", exact: true }).click();
  await eventually(async () => (await page.locator(".gns-ai-summary:visible").count()) === 0, "Disabling summaries did not update the inbox");
  assert.equal(await other.locator(".gns-ai-summary:visible").count(), 0);
  assert.equal(await page.locator(".gns-result").count(), 4);
});

test("Priority filter ranks notifications by direct ask, organizational hierarchy, and recency and sweeps noise in one click", async () => {
  const nowIso = new Date().toISOString();
  const oldIso = "2026-08-01T00:00:00Z";
  await worker.evaluate(async (key) => {
    await chrome.storage.local.set({
      [key]: {
        contacts: {
          "lead-mgr": { points: 30, tier: 1, role: "Engineering Director" },
          "vp-ops": { points: 24, tier: 2, role: "VP, Operations" }
        },
        coreRepos: ["acme/console"],
        adjacentRepos: []
      }
    });
  }, core.PRIORITY_RULES_STORAGE_KEY);
  routeState.rows = [
    { href: "/acme/console/issues/201", title: "Old participating thread", unread: true, reason: "participating", participants: ["stranger"], dateTime: oldIso },
    { href: "/acme/console/issues/202", title: "Standard peer mention", unread: true, reason: "mention", participants: ["ada"], dateTime: nowIso },
    { href: "/acme/console/pull/203#issuecomment-123", title: "Manager urgent ask on roadmap", unread: true, reason: "mention", participants: ["lead-mgr"], dateTime: nowIso },
    { href: "/acme/console/issues/204", title: "Director review thread", unread: true, reason: "review-requested", participants: ["vp-ops"], dateTime: nowIso },
    { href: "/acme/console/issues/205", title: "Team-wide broadcast ping", unread: true, reason: "team-mention", participants: ["stranger"], dateTime: nowIso }
  ];
  routeState.next = null;
  await page.goto("https://github.com/notifications");
  const priorityLink = page.locator("[data-gns-priority-filter]");
  await priorityLink.waitFor();
  await priorityLink.click();
  await page.locator("[data-gns-panel='priority']").waitFor();
  await complete();
  assert.equal(await page.locator(".gns-heading").textContent(), "Priority");
  const titles = await page.locator(".gns-result-title").allTextContents();
  assert.deepEqual(titles, [
    "Manager urgent ask on roadmap",
    "Director review thread",
    "Standard peer mention"
  ]);
  assert.match(await page.locator(".gns-priority-badge").first().textContent(), /^P1 · \d+$/);
  assert.equal(await page.locator(".gns-repo-pill").first().textContent(), "acme/console");
  assert.match(await page.locator(".gns-org-signal").first().textContent(), /@lead-mgr/);
  // One-click sweep buttons in Priority view mark Review requested, Team mentioned, and Stale participating Read & Done
  assert.equal(await page.locator("[data-gns-sweep='review-requested']").textContent(), "Review requested (1)");
  assert.equal(await page.locator("[data-gns-sweep='team-mention']").textContent(), "Team mentioned (1)");
  assert.equal(await page.locator("[data-gns-sweep='stale-participating']").textContent(), "Stale participating (1)");
  await page.locator("[data-gns-sweep='all']").click();
  await eventually(() => (routeState.archivedIds || []).length === 3, "Sweep did not archive noisy notifications");
  assert.match(await page.locator(".gns-sweep-status").textContent(), /Swept 3 noisy notifications/);
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), [
    "Manager urgent ask on roadmap",
    "Standard peer mention"
  ]);
  // Clicking into an issue (which marks it read on GitHub) and coming back keeps the pinned Priority list intact
  routeState.rows = routeState.rows.map((row) =>
    row.href.includes("/issues/202") ? { ...row, unread: false } : row
  );
  await page.goto("https://github.com/acme/console/issues/202");
  await page.goto("https://github.com/notifications#priority");
  await page.locator("[data-gns-panel='priority']").waitFor();
  await complete();
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), [
    "Manager urgent ask on roadmap",
    "Standard peer mention"
  ]);

  // Verify Today, Priority, and Subscriptions are placed at the top of the Filters list
  const filterLabels = await page.getByRole("list", { name: "Filters", exact: true }).locator("li > a").evaluateAll((nodes) =>
    nodes.map((n) => n.textContent.trim().replace(/\s+/g, " "))
  );
  assert.match(filterLabels[0], /^Today/);
  assert.match(filterLabels[1], /^Priority/);
  assert.match(filterLabels[2], /^Subscriptions/);
  assert.equal(filterLabels[3], "Mentioned");

  // Verify Today view (#today) automatically summarizes P1 items and synthesizes the Morning Executive Briefing
  await enableSummaries(false);
  await page.locator("[data-gns-today-filter]").click();
  await page.locator("[data-gns-panel='today']").waitFor();
  await complete();
  assert.equal(await page.locator(".gns-heading").textContent(), "Today");
  await eventually(async () => {
    const p = page.locator(".gns-today-paragraph");
    return (await p.isVisible()) && (await p.textContent()).includes("acme/console#203");
  }, "Today view did not automatically generate the morning executive briefing");
  assert.deepEqual(await page.locator(".gns-result-title").allTextContents(), [
    "Manager urgent ask on roadmap"
  ]);

  // Leaving Today and returning on the same day reuses the saved daily briefing without calling the LLM again
  const chatCallsAfterFirstToday = (await aiState()).calls.filter((c) => c.url.endsWith("/api/chat")).length;
  await page.goto("https://github.com/notifications");
  await page.goto("https://github.com/notifications#today");
  await page.locator("[data-gns-panel='today']").waitFor();
  await eventually(async () => (await page.locator(".gns-today-paragraph").isVisible()) &&
    (await page.locator(".gns-today-paragraph").textContent()).includes("acme/console#203"),
    "Saved daily Today briefing was not restored");
  const chatCallsAfterRevisit = (await aiState()).calls.filter((c) => c.url.endsWith("/api/chat")).length;
  assert.equal(chatCallsAfterRevisit, chatCallsAfterFirstToday, "Revisiting Today on the same day must not regenerate the briefing");

  // Clicking Regenerate briefing explicitly forces a fresh synthesis
  await page.getByRole("button", { name: "Regenerate briefing", exact: true }).click();
  await eventually(async () => (await aiState()).calls.filter((c) => c.url.endsWith("/api/chat")).length > chatCallsAfterRevisit,
    "Regenerate briefing button did not trigger a new synthesis");
  assert.deepEqual(pageErrors, []);
});

test("restores unread state via /notifications/beta/unmark after summarizing an unread notification and prevents native Done DOM swaps from re-queuing summaries", async () => {
  await enableSummaries(true);
  routeState.rows = [
    { href: "/acme/console/issues/11#issuecomment-123", title: "Tighten the release checklist", unread: true, reason: "mention", participants: ["ada"] },
    { href: "/acme/console/pull/42#issuecomment-123", title: "Keep keyboard focus after saving", unread: true, reason: "mention", participants: ["ada"] }
  ];
  routeState.next = null;
  await page.goto("https://github.com/notifications");
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.setAttribute("action", "/notifications/beta/unmark");
    form.innerHTML = '<input type="hidden" name="authenticity_token" value="unmark-tok-1">';
    document.body.append(form);
  });
  await summarized(2);
  await eventually(() => (routeState.unmarkedIds || []).length >= 2, "Unread notifications were not restored via /notifications/beta/unmark");
  const initialChatCalls = (await aiState()).calls.filter((c) => c.url.endsWith("/api/chat")).length;
  assert.equal(initialChatCalls, 2);

  // Simulate GitHub replacing the .js-check-all-container DOM 1s after clicking Done on row 1
  await page.evaluate(() => {
    const container = document.querySelector(".js-check-all-container");
    const clone = container.cloneNode(true);
    clone.querySelectorAll("[data-gns-owned]").forEach((n) => n.remove());
    clone.querySelector(".notifications-list-item").remove();
    container.replaceWith(clone);
  });
  await eventually(async () => (await page.locator(".notifications-list-item .gns-ai-summary[data-state='done']").count()) === 1, "Remaining row did not synchronously restore its summary");
  const afterSwapChatCalls = (await aiState()).calls.filter((c) => c.url.endsWith("/api/chat")).length;
  assert.equal(afterSwapChatCalls, initialChatCalls, "DOM replacement after clicking Done must not re-run local LLM inference");
  assert.deepEqual(pageErrors, []);
});

test("supports two-slot hybrid routing (local Splash for row summaries + GitHub Copilot for Today briefing) and manual-only cost control", async () => {
  const nowIso = new Date().toISOString();
  await worker.evaluate(async (key) => {
    await chrome.storage.local.set({
      [key]: {
        contacts: { "lead-mgr": { points: 30, tier: 1, role: "Engineering Manager" } },
        coreRepos: ["acme/console"],
        adjacentRepos: []
      }
    });
  }, core.PRIORITY_RULES_STORAGE_KEY);
  routeState.rows = [
    { href: "/acme/console/pull/203#issuecomment-123", title: "Manager urgent ask on roadmap", unread: true, reason: "mention", participants: ["lead-mgr"], dateTime: nowIso }
  ];
  routeState.next = null;

  const manager = await openManager();
  // Slot 1: Keep row summaries on $0 local Splash
  assert.equal(await manager.locator("#summary-server").inputValue(), "splash");
  await manager.locator("#connect-models").click();
  await eventually(async () => (await manager.locator("#summary-model").inputValue()) === "splash:mlx-community/Qwen3.8-27B-4bit", "Splash model did not connect");
  await manager.locator("#summary-manual-only").check();

  // Slot 2: Route Today's Executive Briefing to GitHub Copilot (claude-opus-5.5)
  await manager.locator("#briefing-server").selectOption("copilot");
  await manager.locator("#briefing-api-key").fill("gho_copilot_test_token");
  await manager.locator("#connect-briefing-models").click();
  await eventually(async () => (await manager.locator("#briefing-model").inputValue()) === "copilot:auto", "GitHub Copilot briefing model did not connect");
  await manager.locator("#briefing-model").selectOption("copilot:claude-opus-5.5");
  await manager.locator("#save-summary-settings").click();
  await eventually(async () => (await manager.locator("#summary-status").textContent()).includes("Manual row clicks only is on"), "Hybrid settings did not save");

  // On Inbox, bulk "Summarize comments" is hidden by manualOnly, while individual row "Summarize" remains available
  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-native-toolbar]").waitFor();
  assert.equal(await page.getByRole("button", { name: "Summarize comments", exact: true }).isVisible(), false);
  assert.equal(await page.locator(".notifications-list-item .gns-ai-start").first().isVisible(), true);

  // On Today (#today), P1 row is summarized locally via Splash (127.0.0.1:8000) and the Executive Briefing is synthesized via GitHub Copilot (api.githubcopilot.com)
  await page.goto("https://github.com/notifications#today");
  await page.locator("[data-gns-panel='today']").waitFor();
  await eventually(async () => (await page.locator(".gns-today-paragraph").isVisible()) &&
    (await page.locator(".gns-today-paragraph").textContent()).includes("acme/console#203"),
    "Hybrid Today briefing did not finish");
  assert.match(await page.locator(".gns-today-meta").textContent(), /Cloud AI \(copilot:claude-opus-5\.5\)/);
  const calls = (await aiState()).calls;
  assert.ok(calls.some((c) => c.url === "http://127.0.0.1:8000/v1/chat/completions" && c.body?.model === "mlx-community/Qwen3.8-27B-4bit"), "Expected P1 row summary to use local Splash");
  assert.ok(calls.some((c) => c.url === "https://api.githubcopilot.com/chat/completions" && c.body?.model === "claude-opus-5.5"), "Expected Today briefing to use GitHub Copilot claude-opus-5.5");

  // If the cloud model fails (e.g. HTTP 503), Signalbox automatically falls back to local Splash and shows a visible fallback warning
  await worker.evaluate(async (key) => {
    await chrome.storage.local.set({ [key]: { model: "copilot:claude-opus-5.5", automatic: false } });
    globalThis.gnsTestAI.failCopilotChat = true;
  }, summaries.STORAGE_KEY);
  await page.goto("https://github.com/notifications?query=reason%3Amention");
  await page.locator("[data-gns-native-toolbar]").waitFor();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await eventually(async () => (await page.locator(".notifications-list-item .gns-ai-summary[data-state='done']").count()) === 1,
    "Cloud failure did not fall back to local model");
  assert.equal(await page.locator(".notifications-list-item .gns-ai-fallback-pill").isVisible(), true);
  assert.equal(await page.locator(".notifications-list-item .gns-ai-fallback-pill").textContent(), "Local fallback");
  assert.deepEqual(pageErrors, []);
});

test("summarizes notifications on native filter views without requiring items to be in Subscriptions", async () => {
  await enableSummaries(false);
  await page.goto("https://github.com/notifications?query=reason%3Amention");
  await page.locator("[data-gns-native-toolbar]").waitFor();
  assert.equal(await page.locator(".notifications-list-item .gns-ai-start").count(), 5);
  const startEdges = await page.locator(".notifications-list-item .gns-ai-start").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().left))
  );
  assert.ok(startEdges.every((x) => Math.abs(x - startEdges[0]) <= 1), `Expected Summarize buttons to share one vertical scan edge, got ${startEdges.join(", ")}`);
  const summarizeAll = page.getByRole("button", { name: "Summarize comments", exact: true });
  await eventually(() => summarizeAll.isEnabled(), "Summarize comments button did not enable on native filter view");
  await summarizeAll.click();
  await summarized(5);
  const summaryEdges = await page.locator(".notifications-list-item .gns-ai-line").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().left))
  );
  assert.ok(summaryEdges.every((x) => Math.abs(x - summaryEdges[0]) <= 1), `Expected summaries to share one vertical scan edge, got ${summaryEdges.join(", ")}`);
  await page.screenshot({ path: path.join(resultsPath, "notifications-native-summaries.png"), fullPage: true });
  const row = page.locator(".notifications-list-item").nth(2);
  assert.match(await row.locator(".gns-ai-text").textContent(), /Keyboard focus/);
  await row.locator(".gns-more").click();
  assert.match(await row.locator(".gns-ai-action").textContent(), /Review/);
  assert.equal(await page.locator(".js-check-all-container").isVisible(), true);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);

  // Verify nested GitHub Primer rows (.d-flex { display: flex !important }) keep the exact same middle-column X coordinate across rows with varying titles and right-side metadata
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".d-flex { display: flex !important; } .flex-md-1 { flex: 1 !important; }";
    document.head.append(style);
    const list = document.querySelector(".notifications-list");
    list.innerHTML = [
      { href: "/acme/console/issues/11", title: "Coordinate on the 6 reporting forms (report-abuse, dmca, private-information, trademark-policy, government-takedown)", unread: true, reason: "subscribed", avatars: ["maya", "sam", "ada"] },
      { href: "/acme/console/issues/42", title: "[feature_flag_cleanup] Feature Flag Lifecycle Tracking", unread: true, reason: "author", avatars: [] },
      { href: "/acme/console/pull/73", title: "Restructure API & Integrations intake templates around symptoms", unread: false, reason: "review-requested", avatars: ["morgan"] },
      { href: "/acme/console/issues/84", title: "Expand automated reply coverage to Billing, then Compliance", unread: false, reason: "mention", avatars: ["jules", "sam"] }
    ].map((item, idx) => `<li class="notifications-list-item" data-notification-id="nested-${idx}">
      <div class="d-flex flex-column flex-md-row flex-md-items-center">
        <div class="d-flex flex-row flex-md-1">
          <div class="d-flex"><input type="checkbox"></div>
          <a class="d-flex notification-list-item-link" href="${item.href}"><span class="markdown-title">${item.title}</span></a>
        </div>
        <div class="d-flex flex-row flex-md-row-reverse">
          <relative-time datetime="2026-10-19T12:00:00Z">2 hours ago</relative-time>
          <div class="AvatarStack-body">${item.avatars.map((a) => `<a class="avatar" href="/${a}">${a}</a>`).join("")}</div>
          <span class="f6">${item.reason}</span>
        </div>
      </div>
    </li>`).join("");
  });
  await eventually(async () => (await page.locator(".notifications-list-item .gns-ai-start").count()) === 4, "Nested rows were not decorated");
  const nestedEdges = await page.locator(".notifications-list-item .gns-native-activity").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().left))
  );
  assert.ok(nestedEdges.every((x) => Math.abs(x - nestedEdges[0]) <= 1), `Expected nested rows to share one vertical scan edge, got ${nestedEdges.join(", ")}`);
  assert.deepEqual(pageErrors, []);
});

test("bookmark button does not increase row height or jump when clicked", async () => {
  await page.goto("https://github.com/notifications");
  const row = page.locator(".notifications-list-item").first();
  const pin = row.locator("[data-gns-pin]");
  await pin.waitFor();
  await eventually(() => pin.isEnabled(), "Pin is not ready");
  const heights = await row.evaluate(async (node) => {
    const inline = node.querySelector("[data-gns-row-inline]");
    inline.style.display = "none";
    const withoutControls = node.getBoundingClientRect().height;
    inline.style.display = "";
    const withControls = node.getBoundingClientRect().height;
    const observed = [withControls];
    const observer = new ResizeObserver(() => observed.push(node.getBoundingClientRect().height));
    observer.observe(node);
    const button = node.querySelector("[data-gns-pin]");
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    observed.push(node.getBoundingClientRect().height);
    button.click();
    observed.push(node.getBoundingClientRect().height);
    await new Promise((resolve) => setTimeout(resolve, 120));
    observed.push(node.getBoundingClientRect().height);
    observer.disconnect();
    return { withoutControls, withControls, observed };
  });
  assert.equal(heights.withControls, heights.withoutControls, "Bookmark button must not increase row height");
  for (const h of heights.observed) {
    assert.equal(h, heights.withoutControls, "Row height must not jump when bookmark button is clicked");
  }
  assert.equal(await pin.getAttribute("aria-pressed"), "true");
  assert.deepEqual(pageErrors, []);
});

test("unreadable AI settings do not break filtering and can be reset without losing subscriptions", async () => {
  await seed();
  await worker.evaluate(async (key) => chrome.storage.local.set({ [key]: { model: 42 } }), summaries.STORAGE_KEY);
  await openFilter();
  await complete();
  await eventually(async () => (await page.locator(".gns-summary-note").getAttribute("data-failed")) === "true", "Settings error was not shown");
  assert.equal(await page.locator(".gns-result").count(), 4);
  const manager = await openManager();
  await manager.getByRole("button", { name: "Reset AI settings", exact: true }).click();
  await eventually(async () => (await page.locator(".gns-summary-note").getAttribute("data-failed")) === "false", "Reset did not recover summary settings");
  assert.equal(await page.locator(".gns-result").count(), 4);
  assert.equal(previewRequests().length, 0);
});

test("shows local AI summaries and settings without narrow or dark layout overflow", async () => {
  await seed();
  await enableSummaries(true);
  await openFilter();
  await complete();
  await summarized();
  await assertRowLayout("columns");
  await page.screenshot({ path: path.join(resultsPath, "summaries-desktop.png"), fullPage: true });
  await page.locator(".gns-panel").evaluate((node) => { node.style.maxWidth = "680px"; });
  await assertRowLayout();
  await page.locator(".gns-panel").evaluate((node) => { node.style.maxWidth = ""; });
  await page.setViewportSize({ width: 960, height: 900 });
  await assertRowLayout();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertRowLayout("stacked");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(resultsPath, "summaries-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await assertRowLayout();
  await page.screenshot({ path: path.join(resultsPath, "summaries-dark.png"), fullPage: true });
  const manager = await openManager();
  await manager.setViewportSize({ width: 390, height: 844 });
  await manager.locator("#connect-models").click();
  await eventually(async () => manager.locator("#save-summary-settings").isEnabled(), "Model settings did not become ready");
  assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await manager.screenshot({ path: path.join(resultsPath, "summaries-settings.png"), fullPage: true });
  assert.deepEqual(pageErrors, []);
});

test("keeps long titles and expanded comments readable across row widths", async () => {
  const longToken = "ExtremelyLongIdentifier_".repeat(140);
  const longTitle = "Make sensitive-data removal clear in the Repositories support form without hiding important notification context or the request that needs a response";
  routeState.rows = [{
    ...fixture.pages[0][2], title: longTitle,
    participants: ["first-participant-with-a-long-username", "second-participant-with-a-long-name"]
  }];
  routeState.next = null;
  routeState.previewHtml = fixture.commentPage({ body: `<p>Review the keyboard fix before release.</p><p>${longToken}</p>` });
  await aiState({ result: {
    summary: `The update keeps notification details visible while making summaries easier to scan. It includes ${"LongIdentifier".repeat(12)}.`,
    action: "Review the keyboard fix before release.", response: "unclear", evidence: ""
  } });
  await seed();
  await enableSummaries(true);
  await openFilter();
  await complete();
  await summarized(1);
  const row = page.locator(".gns-result").first();
  const toggle = row.locator(".gns-ai-toggle");
  await toggle.waitFor({ state: "visible" });
  assert.equal(await toggle.textContent(), "Show more");
  await toggle.click();
  assert.equal(await toggle.textContent(), "Show less");
  assert.equal(await row.locator(".gns-ai-line").getAttribute("data-expanded"), "true");
  await toggle.click();
  assert.equal(await toggle.textContent(), "Show more");
  await (await previewToggle(row)).click();
  await eventually(async () => (await row.locator(".gns-preview-text").textContent()).includes(longToken), "Long preview did not load");
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.locator(".Layout").evaluate((node) => { node.style.maxWidth = "none"; });
  await assertRowLayout();
  for (const width of [960, 700, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertRowLayout();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await row.locator(".gns-preview-text").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await row.locator(".gns-result-title").textContent(), longTitle);
    assert.equal(await row.locator(".gns-preview-text").textContent(), `Review the keyboard fix before release.\n${longToken}`);
  }
  assert.equal(await row.locator(".gns-preview-text").evaluate((node) => node.scrollHeight > node.clientHeight && node.clientHeight <= 360), true);
  assert.deepEqual(pageErrors, []);
});

test("keeps keyboard order consistent between column and stacked rows", async () => {
  await seed();
  await enableSummaries();
  await openFilter();
  await complete();
  const row = page.locator(".gns-result").nth(1);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await row.locator(".gns-result-link").focus();
    for (const selector of [".gns-ai-summary button", ".gns-caught-up", ".gns-more"]) {
      await page.keyboard.press("Tab");
      assert.equal(await row.locator(selector).evaluate((node) => document.activeElement === node), true, `Expected focus on ${selector}`);
    }
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".gns-result-link").nth(2).evaluate((node) => document.activeElement === node), true);
  }
  await row.locator(".gns-more").focus();
  await page.keyboard.press("Enter");
  assert.equal(await row.locator(".gns-more").getAttribute("aria-expanded"), "true");
  for (const selector of [".gns-participant-links a", ".gns-preview summary", ".gns-pin"]) {
    await page.keyboard.press("Tab");
    assert.equal(await row.locator(selector).first().evaluate((node) => document.activeElement === node), true, `Expected focus on ${selector}`);
  }
  await row.locator(".gns-more").click();
  assert.equal(await row.locator(".gns-result-details").isHidden(), true);
  assert.equal(previewRequests().length, 0);
  assert.deepEqual(pageErrors, []);
});

test("caught-up markers persist, undo across tabs, and let new activity return without native writes", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await openFilter();
  await complete();
  const other = await context.newPage();
  await other.goto("https://github.com/notifications#subscriptions");
  await other.locator(".gns-caught-up").waitFor();
  await page.locator(".gns-caught-up").click();
  await eventually(async () => await page.locator(".gns-result").count() === 0 && await other.locator(".gns-result").count() === 0, "Caught-up state did not hide the update across tabs");
  assert.equal(await page.getByRole("button", { name: "Undo caught up", exact: true }).evaluate((node) => node === document.activeElement), true);
  assert.equal(previewRequests().length, 0);
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  await page.getByRole("button", { name: "Undo caught up", exact: true }).click();
  await eventually(async () => await other.locator(".gns-result").count() === 1, "Undo did not restore the other tab");
  await page.locator(".gns-caught-up").click();
  await page.reload();
  await complete();
  await page.getByRole("heading", { name: "You're caught up", exact: true }).waitFor();
  await openMenu();
  await page.getByRole("button", { name: "Show caught up (1)", exact: true }).click();
  assert.equal(await page.locator(".gns-result[data-caught-up='true']").count(), 1);
  routeState.rows = [{ ...fixture.pages[0][2], dateTime: "2026-09-26T18:00:00Z" }];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 1);
  assert.equal(await page.locator(".gns-result").getAttribute("data-caught-up"), "false");
  assert.equal(await page.evaluate(() => window.fixtureWrites), 0);
  assert.ok(routeState.requests.every((request) => request.method === "GET"));
});

test("saved snapshots work offline and rechecks reuse unchanged sources but replace edited summaries", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  const calls = () => aiState().then((state) => state.calls.filter((call) => call.url.endsWith("/api/chat")).length);
  const initialCalls = await calls();
  const sourceRequests = previewRequests().length;
  await aiState({ tagsStatus: 503 });
  await page.reload();
  await complete();
  await summarized(1);
  assert.equal(previewRequests().length, sourceRequests);
  assert.equal(await calls(), initialCalls);
  assert.match(await page.locator(".gns-ai-freshness").textContent(), /not rechecked this visit/);
  await (await recheckButton(page)).click();
  await summarized(1);
  assert.match(await page.locator(".gns-ai-freshness").textContent(), /Source unchanged; reused summary/);
  assert.equal(await calls(), initialCalls);
  assert.equal(previewRequests().length, sourceRequests + 1);
  routeState.previewHtml = fixture.commentPage({ body: "<p>The keyboard fix was withdrawn. No review is needed.</p>" });
  await aiState({ tagsStatus: 200, result: { summary: "@ada withdrew the keyboard fix.", action: "", response: "fyi", evidence: "" } });
  await (await recheckButton(page)).click();
  await summarized(1);
  assert.equal(await calls(), initialCalls + 1);
  assert.match(await page.locator(".gns-ai-text").textContent(), /withdrew/);
  routeState.rows = [{ ...fixture.pages[0][2], dateTime: "2026-09-26T18:00:00Z" }];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  await page.getByRole("button", { name: "Summarize", exact: true }).waitFor();
  assert.equal(await page.locator(".gns-ai-text").textContent(), "");
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  assert.equal(await calls(), initialCalls + 1);
  assert.match(await page.locator(".gns-ai-freshness").textContent(), /Source unchanged/);
  assert.deepEqual(pageErrors, []);
});

test("response labels name the people and disclose an exact request quote separately from native reasons", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await aiState({ result: {
    summary: "@ada asked @you to review the keyboard fix; focus now returns to Save.",
    action: "@you: review the keyboard fix.", response: "needs_response",
    evidence: "@you, could you review the keyboard fix?"
  } });
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  assert.match(await page.locator(".gns-ai-label").textContent(), /Needs your response/);
  assert.match(await page.locator(".gns-ai-text").textContent(), /@ada asked you to review the keyboard fix/);
  assert.doesNotMatch(await page.locator(".gns-ai-text").textContent(), /Nothing needed from you/);
  assert.match(await page.locator(".gns-kind[data-kind='needs_response']").first().getAttribute("aria-label"), /^Needs your response \(local AI\)/);
  assert.equal(await page.locator(".gns-reason").textContent(), "mention");
  assert.match(await page.locator(".gns-ai-meta").textContent(), /@ada/);
  await openDetails(page.locator(".gns-result").first());
  await page.locator(".gns-ai-evidence summary").click();
  assert.equal(await page.locator(".gns-ai-evidence blockquote").textContent(), "@you, could you review the keyboard fix?");
  await page.locator(".gns-preview > summary").click();
  await eventually(async () => (await page.locator(".gns-preview-text").textContent()).includes("Focus now returns"), "The exact source was not retained");
  assert.deepEqual(pageErrors, []);
});

test("account changes never reuse another login's summaries or caught-up markers", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  await page.locator(".gns-caught-up").click();
  await eventually(async () => await page.locator(".gns-result").count() === 0, "Marking caught up failed");
  await page.evaluate(() => document.querySelector('meta[name="user-login"]').content = "another-user");
  await eventually(async () => await page.locator(".gns-result").count() === 1, "Account change did not restart the local view");
  await page.getByRole("button", { name: "Summarize", exact: true }).waitFor();
  assert.equal(await page.locator(".gns-ai-text").textContent(), "");
  assert.equal(await page.locator(".gns-result").getAttribute("data-caught-up"), "false");
  await page.evaluate(() => document.querySelector('meta[name="user-login"]').remove());
  await eventually(async () => (await page.locator(".gns-review-note").textContent()).includes("username unavailable"), "Missing identity was not explained");
  assert.equal(await page.locator(".gns-caught-up").isEnabled(), false);
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  assert.match(await page.locator(".gns-ai-freshness").textContent(), /Not saved/);
  const values = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(Object.keys(values).filter((key) => key.startsWith(storeApi.CACHE_PREFIX)).length, 1);
  assert.equal(Object.keys(values).filter((key) => key.startsWith(storeApi.REVIEW_PREFIX)).length, 1);
  assert.deepEqual(pageErrors, []);
});

test("missing update times disable caught-up tracking without disabling filtering", async () => {
  routeState.rows = [{ ...fixture.pages[0][2], dateTime: "" }];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await openFilter();
  await complete();
  assert.equal(await page.locator(".gns-result").count(), 1);
  assert.equal(await page.locator(".gns-caught-up").isEnabled(), false);
  assert.match(await page.locator(".gns-caught-up").getAttribute("title"), /update time/);
});

test("clearing saved summaries stops in-flight work and does not restart automatic generation", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries(true);
  await aiState({ delay: 900 });
  await openFilter();
  await eventually(async () => (await aiState()).active === 1, "Inference did not start");
  const manager = await openManager();
  await manager.locator("#clear-summary-cache").click();
  await eventually(async () => (await manager.locator("#local-data-status").textContent()).startsWith("Saved summaries cleared"), "Cache clear did not finish");
  await page.waitForTimeout(1100);
  assert.equal(await page.locator(".gns-ai-summary[data-state='done']").count(), 0);
  assert.equal((await aiState()).aborted, 1);
  assert.equal((await aiState()).calls.filter((call) => call.url.endsWith("/api/chat")).length, 1);
  const values = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(Object.keys(values).filter((key) => key.startsWith(storeApi.CACHE_PREFIX)).length, 0);
  assert.deepEqual(values[summaries.STORAGE_KEY], { model: "gemma4:12b-it-qat", automatic: true });
  assert.equal(Object.keys(values).filter((key) => key.startsWith(core.STORAGE_PREFIX)).length, 1);
  assert.deepEqual(pageErrors, []);
});

test("rechecked comments fall back to the thread content when the linked comment is removed", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries(true);
  await openFilter();
  await complete();
  await summarized(1);
  routeState.previewHtml = fixture.commentPage({ missing: true });
  await aiState({ result: { summary: "@maya added an update on the thread after the earlier comment was removed.", action: "", response: "fyi", evidence: "" } });
  await (await recheckButton(page)).click();
  await summarized(1);
  assert.equal(await page.locator(".gns-ai-summary").getAttribute("data-state"), "done");
  assert.match(await page.locator(".gns-ai-text").textContent(), /@maya/);
  const values = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(Object.keys(values).filter((key) => key.startsWith(storeApi.CACHE_PREFIX)).length, 1);
  assert.equal((await aiState()).calls.filter((call) => call.url.endsWith("/api/chat")).length, 2);
});

test("corrupt local review state has its own recoverable error and does not invalidate the inbox scan", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await worker.evaluate((key) => chrome.storage.local.set({ [key]: {} }), storeApi.reviewKey("you", "acme/console#42"));
  await openFilter();
  await complete();
  await page.locator(".gns-local-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".gns-local-error").textContent(), /Reset caught-up state/);
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  const manager = await openManager();
  await manager.locator("#clear-review-state").click();
  await eventually(async () => await page.locator(".gns-caught-up").isEnabled(), "Reset did not recover local review state");
  assert.equal(await page.locator(".gns-local-error").isVisible(), false);
  assert.equal(await page.locator(".gns-result").count(), 1);
});

test("source edits in another tab replace the saved summary without leaving an old preview beside it", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  await (await previewToggle(page.locator(".gns-result").first())).click();
  await eventually(async () => (await page.locator(".gns-preview-text").textContent()).includes("Focus now returns"), "Original preview did not load");
  const other = await context.newPage();
  await other.goto("https://github.com/notifications#subscriptions");
  await (await recheckButton(other)).waitFor();
  routeState.previewHtml = fixture.commentPage({ body: "<p>The keyboard fix was withdrawn. No review is needed.</p>" });
  await aiState({ result: { summary: "@ada withdrew the keyboard fix.", action: "", response: "fyi", evidence: "" } });
  await (await recheckButton(other)).click();
  await eventually(async () => (await page.locator(".gns-ai-text").textContent()).includes("withdrew"), "Saved summary did not update across tabs");
  assert.equal(await page.locator(".gns-preview").getAttribute("open"), null);
  assert.equal(await page.locator(".gns-preview-text").textContent(), "");
  await page.locator(".gns-preview > summary").click();
  await eventually(async () => (await page.locator(".gns-preview-text").textContent()).includes("withdrawn"), "Preview did not reload the changed source");
  assert.equal((await aiState()).calls.filter((call) => call.url.endsWith("/api/chat")).length, 2);
  assert.deepEqual(pageErrors, []);
});

test("different comments and models cannot reuse saved assessments and long titles stay readable", async () => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  const title = "Long notification title ".repeat(35).trim();
  routeState.rows = [{
    ...fixture.pages[0][2], title,
    href: "/acme/console/pull/42#issuecomment-125", dateTime: "2026-09-26T18:00:00Z"
  }];
  routeState.previewHtml = fixture.commentPage({ id: "issuecomment-125" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await complete();
  await page.getByRole("button", { name: "Summarize", exact: true }).waitFor();
  assert.equal(await page.locator(".gns-ai-text").textContent(), "");
  assert.equal(await page.locator(".gns-result-title").textContent(), title);
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  let state = await aiState();
  let calls = state.calls.filter((call) => call.url.endsWith("/api/chat"));
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body.messages[1].content).title.length, 500);
  await aiState({ models: [...state.models, { name: "another-model", size: 100, details: { format: "gguf" }, capabilities: ["completion"] }] });
  await worker.evaluate((key) => chrome.storage.local.set({ [key]: { model: "another-model", automatic: false } }), summaries.STORAGE_KEY);
  await page.getByRole("button", { name: "Summarize", exact: true }).waitFor();
  assert.equal(await page.locator(".gns-ai-text").textContent(), "");
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await summarized(1);
  calls = (await aiState()).calls.filter((call) => call.url.endsWith("/api/chat"));
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.model, "another-model");
  assert.deepEqual(pageErrors, []);
});

test("summary storage failures are visible and retry recovers without breaking the completed scan", async (t) => {
  routeState.rows = [fixture.pages[0][2]];
  routeState.next = null;
  await seed([fixture.subscriptions[1]]);
  await enableSummaries();
  await worker.evaluate((prefix) => {
    globalThis.gnsOriginalStorageSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (updates) => {
      if (Object.keys(updates).some((key) => key.startsWith(prefix))) throw new Error("Summary storage quota exceeded");
      return globalThis.gnsOriginalStorageSet(updates);
    };
  }, storeApi.CACHE_PREFIX);
  const restore = () => worker.evaluate(() => { chrome.storage.local.set = globalThis.gnsOriginalStorageSet; });
  t.after(restore);
  await openFilter();
  await complete();
  await page.getByRole("button", { name: "Summarize comments", exact: true }).click();
  await page.getByRole("button", { name: "Retry summary", exact: true }).waitFor();
  assert.match(await page.locator(".gns-ai-status").textContent(), /quota exceeded/);
  assert.equal(await page.locator(".gns-ai-text").textContent(), "");
  assert.equal(await page.locator(".gns-error").isVisible(), false);
  await restore();
  await page.getByRole("button", { name: "Retry summary", exact: true }).click();
  await summarized(1);
  assert.match(await page.locator(".gns-status").textContent(), /Inbox search complete/);
  assert.deepEqual(pageErrors, []);
});

test("renders readable desktop, narrow, dark, and popup layouts", async () => {
  await seed();
  await openFilter();
  await complete();
  await (await previewToggle(page.locator(".gns-result").nth(1))).click();
  await eventually(async () => (await page.locator(".gns-preview-text").allTextContents()).some((text) => text.includes("keyboard fix")), "Screenshot preview did not load");
  await assertRowLayout();
  await page.screenshot({ path: path.join(resultsPath, "notifications-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertRowLayout();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(resultsPath, "notifications-mobile.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(resultsPath, "notifications-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  const form = await openNewFilter();
  await form.getByRole("button", { name: "Use subscription list" }).click();
  await page.screenshot({ path: path.join(resultsPath, "notifications-create-filter.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("dialog").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: path.join(resultsPath, "notifications-create-filter-mobile.png"), fullPage: true });
  const manager = await openManager();
  await manager.setViewportSize({ width: 1000, height: 900 });
  await manager.screenshot({ path: path.join(resultsPath, "manager-desktop.png"), fullPage: true });
  await manager.setViewportSize({ width: 390, height: 844 });
  assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await manager.screenshot({ path: path.join(resultsPath, "manager-mobile.png"), fullPage: true });
  const popup = await openManager(true);
  await popup.setViewportSize({ width: 420, height: 650 });
  assert.equal(await popup.locator("html").getAttribute("data-popup"), "");
  await popup.screenshot({ path: path.join(resultsPath, "manager-popup.png"), fullPage: true });
  assert.deepEqual(pageErrors, []);
});
