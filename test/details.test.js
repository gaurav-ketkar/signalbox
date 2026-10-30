const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const storeApi = require("../store.js");
const details = require("../details.js");

function storage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
    },
    async set(updates) { Object.assign(values, updates); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

const ISSUE = "https://github.com/acme/console/issues/12";
const PULL = "https://github.com/acme/console/pull/13";
const DISCUSSION = "https://github.com/acme/console/discussions/14";
const RELEASE = "https://github.com/acme/console/releases/tag/v1.0.0";
const COMMIT = "https://github.com/acme/console/commit/9490d2012345678901234567890123456789abcd";

test("normalizeState maps GitHub's wording to four plain states", () => {
  assert.equal(core.normalizeState("Status: Open"), "open");
  assert.equal(core.normalizeState("Status: Closed"), "closed");
  assert.equal(core.normalizeState("Status: Closed as not planned"), "closed");
  assert.equal(core.normalizeState("Not planned"), "closed");
  assert.equal(core.normalizeState("Merged"), "merged");
  assert.equal(core.normalizeState("Draft"), "draft");
  assert.equal(core.normalizeState("Something new"), "");
  assert.equal(core.normalizeState(undefined), "");
});

test("titleFromDocumentTitle reads titles only when the page title names this exact item", () => {
  const issue = core.parseItem("https://github.com/microsoft/TypeScript/issues/1");
  assert.equal(core.titleFromDocumentTitle("Suggestion: 'protected' modifier · Issue #1 · microsoft/TypeScript · GitHub", issue), "Suggestion: 'protected' modifier");
  assert.equal(core.titleFromDocumentTitle("Something else · Issue #2 · microsoft/TypeScript · GitHub", issue), "");
  assert.equal(core.titleFromDocumentTitle("Something · Issue #1 · other/repo · GitHub", issue), "");
  const pull = core.parseItem("https://github.com/cli/cli/pull/9000");
  assert.equal(core.titleFromDocumentTitle("Add a flag · with dots by andyfeller · Pull Request #9000 · cli/cli · GitHub", pull), "Add a flag · with dots");
  const discussion = core.parseItem("https://github.com/cli/cli/discussions/9100");
  assert.equal(core.titleFromDocumentTitle("installation · cli/cli · Discussion #9100 · GitHub", discussion), "installation");
  const commit = core.parseItem("https://github.com/cli/cli/commit/9490d2012345678901234567890123456789abcd");
  assert.equal(core.titleFromDocumentTitle("Merge pull request #14879 from x/y · cli/cli@9490d20 · GitHub", commit), "Merge pull request #14879 from x/y");
  assert.equal(core.titleFromDocumentTitle("Release v1.0.0 · acme/console · GitHub", core.parseItem(RELEASE)), "");
  assert.equal(core.titleFromDocumentTitle("GitHub", issue), "");
});

test("list joins titles and states, and add keeps titles known at save time", async () => {
  const area = storage();
  const store = storeApi.createStore(area);
  await store.add([{ url: ISSUE, title: "Fix login", state: "Status: Closed" }, PULL]);
  const saved = await store.list();
  const issue = saved.find((item) => item.url === ISSUE);
  assert.equal(issue.title, "Fix login");
  assert.equal(issue.state, "closed");
  assert.ok(Number.isFinite(issue.checkedAt));
  const pull = saved.find((item) => item.url === PULL);
  assert.equal(pull.title, undefined);
  assert.equal(Object.hasOwn(area.values, storeApi.DETAILS_PREFIX + pull.key), false);
});

test("saveDetails fills titles once, follows states, and never brings back removed items", async () => {
  const area = storage();
  const store = storeApi.createStore(area);
  await store.add([ISSUE]);
  assert.equal(await store.saveDetails([{ url: ISSUE, title: "First title", state: "open", checked: true }]), 1);
  assert.equal(await store.saveDetails([{ url: ISSUE, title: "Renamed later", state: "open", checked: true }]), 0);
  assert.equal(await store.saveDetails([{ url: ISSUE, state: "Status: Closed" }]), 1);
  let [item] = await store.list();
  assert.equal(item.title, "First title");
  assert.equal(item.state, "closed");
  await store.remove(ISSUE);
  assert.equal(await store.saveDetails([{ url: ISSUE, title: "Late", checked: true }]), 0);
  assert.deepEqual(Object.keys(area.values), []);
  [item] = await store.list();
  assert.equal(item, undefined);
});

test("removeMany removes related records and restore brings them all back", async () => {
  const area = storage();
  const store = storeApi.createStore(area);
  await store.add([{ url: ISSUE, title: "Fix login", state: "closed" }, PULL]);
  const key = core.parseItem(ISSUE).key;
  area.values[storeApi.reviewKey("octo", key)] = { activity: "x", markedAt: 1 };
  area.values[storeApi.cacheKey("octo", key)] = { cached: true };
  area.values[storeApi.cacheKey("octo", key + "0")] = { other: true };
  const snapshot = await store.removeMany([ISSUE]);
  assert.equal(Object.keys(snapshot).length, 4);
  assert.deepEqual((await store.list()).map((item) => item.url), [PULL]);
  assert.ok(Object.hasOwn(area.values, storeApi.cacheKey("octo", key + "0")));
  assert.equal(await store.restore({ ...snapshot, "unrelated-setting": true }), 1);
  assert.equal(Object.hasOwn(area.values, "unrelated-setting"), false);
  const restored = (await store.list()).find((item) => item.url === ISSUE);
  assert.equal(restored.title, "Fix login");
  assert.ok(Object.hasOwn(area.values, storeApi.reviewKey("octo", key)));
});

test("isDetailsChange is separate from subscription changes", () => {
  const change = { [storeApi.DETAILS_PREFIX + "acme/console#12"]: {} };
  assert.equal(storeApi.isDetailsChange(change, "local"), true);
  assert.equal(storeApi.isSubscriptionChange(change, "local"), false);
});

test("hovercardUrl covers card types and skips releases", () => {
  assert.equal(details.hovercardUrl({ url: ISSUE }), `${ISSUE}/hovercard`);
  assert.equal(details.hovercardUrl({ url: COMMIT }), `${COMMIT}/hovercard`);
  assert.equal(details.hovercardUrl({ url: RELEASE }), "");
});

function response(status, { url, type = "text/html", body = "<card>" } = {}) {
  return {
    status, ok: status >= 200 && status < 300, url,
    headers: { get: () => type },
    text: async () => body
  };
}

test("load reads cards and sorts failures into skip-this-item or stop-the-run", async () => {
  const parse = () => ({ card: true });
  const item = { url: ISSUE };
  const card = (status, options) => details.load(item, { parse, fetchPage: async (url) => response(status, { url, ...options }) });
  await assert.rejects(card(404), (error) => error.name === "DetailsError" && !error.stop);
  await assert.rejects(card(429), (error) => error.stop === true);
  await assert.rejects(card(503), (error) => error.stop === true);
  await assert.rejects(card(200, { url: "https://github.com/login" }), (error) => error.stop === true);
  await assert.rejects(card(200, { type: "application/json" }), (error) => !error.stop);
  await assert.rejects(details.load(item, { parse, fetchPage: async () => { throw new TypeError("offline"); } }), (error) => error.stop === true);
  await assert.rejects(details.load({ url: RELEASE }, { parse }), (error) => error.name === "DetailsError");
});

test("needsDetails retries missing titles daily and rechecks open issues twice a day", () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  assert.equal(details.needsDetails({ url: ISSUE }, now), true);
  assert.equal(details.needsDetails({ url: ISSUE, checkedAt: now - hour }, now), false);
  assert.equal(details.needsDetails({ url: ISSUE, checkedAt: now - 25 * hour }, now), true);
  assert.equal(details.needsDetails({ url: ISSUE, title: "T", state: "open", checkedAt: now - 13 * hour }, now), true);
  assert.equal(details.needsDetails({ url: ISSUE, title: "T", state: "closed", checkedAt: 0 }, now), false);
  assert.equal(details.needsDetails({ url: PULL, title: "T", state: "merged", checkedAt: 0 }, now), false);
  assert.equal(details.needsDetails({ url: DISCUSSION, title: "T", checkedAt: 0 }, now), false);
  assert.equal(details.needsDetails({ url: RELEASE }, now), false);
});

function record(url, extra = {}) {
  return { ...core.parseItem(url), ...extra };
}

test("backfill saves results, skips failures for a day, and stops when GitHub is busy", async () => {
  const saved = [];
  const signal = new AbortController().signal;
  const records = [record(ISSUE), record(PULL), record(DISCUSSION)];
  const result = await details.backfill(records, {
    signal, gapMs: 0, workers: 1,
    save: async (batch) => saved.push(...batch),
    loadCard: async (item) => {
      if (item.url === PULL) throw new details.DetailsError("no card");
      return { title: `Title ${item.label}`, state: "open" };
    }
  });
  assert.equal(result.checked, 3);
  assert.equal(result.stopped, null);
  assert.equal(result.more, false);
  assert.deepEqual(saved.find((entry) => entry.url === PULL), { url: PULL, checked: true });
  assert.equal(saved.find((entry) => entry.url === ISSUE).title, "Title acme/console#12");

  const stoppedSaves = [];
  const busy = await details.backfill(records, {
    signal, gapMs: 0, workers: 1,
    save: async (batch) => stoppedSaves.push(...batch),
    loadCard: async () => { throw new details.DetailsError("busy", { stop: true }); }
  });
  assert.equal(busy.stopped.message, "busy");
  assert.equal(busy.checked, 0);
  assert.deepEqual(stoppedSaves, []);
});

test("backfill honors tried, latest, and the round limit", async () => {
  const signal = new AbortController().signal;
  const records = [record(ISSUE), record(PULL), record(DISCUSSION)];
  const tried = new Set([record(ISSUE).key]);
  const loaded = [];
  const result = await details.backfill(records, {
    signal, gapMs: 0, limit: 1, tried,
    save: async () => {},
    latest: (item) => item.url === PULL ? { ...item, title: "Already known", state: "closed" } : item,
    loadCard: async (item) => { loaded.push(item.url); return { title: "T" }; }
  });
  assert.equal(result.more, true);
  assert.deepEqual(loaded, []);
  assert.ok(tried.has(record(PULL).key));
  const next = await details.backfill(records, {
    signal, gapMs: 0, tried, save: async () => {},
    loadCard: async (item) => { loaded.push(item.url); return { title: "T" }; }
  });
  assert.deepEqual(loaded, [DISCUSSION]);
  assert.equal(next.more, false);
});
