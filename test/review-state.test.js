const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const summary = require("../summary.js");
const api = require("../store.js");

const item = {
  href: "https://github.com/acme/console/pull/42#issuecomment-123",
  title: "Keyboard fix", state: "Merged", dateTime: "2026-09-25T18:00:00Z"
};
const source = {
  ...item, model: "local-model", viewer: "you", author: "ada", truncated: false,
  text: "@you, please review the fix. The full source is not saved."
};

function storage() {
  const values = {};
  return {
    values,
    get: async (keys) => keys === null ? { ...values } :
      Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]])),
    set: async (updates) => { Object.assign(values, updates); },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  };
}

async function record(overrides = {}) {
  return {
    viewer: "you", href: item.href, model: source.model, summaryVersion: summary.SUMMARY_VERSION,
    activity: api.activityToken(item), fingerprint: await api.sourceFingerprint(source),
    result: {
      summary: "@ada asked @you to review the keyboard fix.", action: "@you: review the fix.",
      response: "needs_response", evidence: "@you, please review the fix."
    },
    author: "ada", dateTime: source.dateTime, truncated: false,
    generatedAt: Date.now(), checkedAt: Date.now(), ...overrides
  };
}

test("GitHub identity normalization rejects malformed, padded, and non-string logins", () => {
  for (const [input, expected] of [["YOU", "you"], ["sam-1", "sam-1"], ["a", "a"], ["a".repeat(39), "a".repeat(39)]]) {
    assert.equal(core.normalizeLogin(input), expected);
  }
  for (const value of [undefined, null, "", {}, 1, "@you", "-you", "you-", "a".repeat(40), "you/repo", " you", "you\n", "you\r", "you name", "y_ou"]) {
    assert.equal(core.normalizeLogin(value), "", String(value));
  }
});

test("activity revisions ignore GitHub read/reason state but include time, target, title, and item state", () => {
  const token = api.activityToken(item);
  assert.equal(api.activityToken({ ...item, unread: true, reason: "mention" }), token);
  assert.equal(api.activityToken({ ...item, href: item.href.replace("#", "?notification_referrer_id=secret#") }), token);
  for (const change of [
    { dateTime: "2026-09-25T18:01:00Z" }, { href: item.href.replace("123", "124") },
    { title: "Updated title" }, { state: "Open" }
  ]) assert.notEqual(api.activityToken({ ...item, ...change }), token);
  for (const dateTime of ["", undefined, "invalid"]) assert.equal(api.activityToken({ ...item, dateTime }), "");
});

test("caught-up state is account-scoped, persistent, and conservative about newer updates", async () => {
  const area = storage();
  const first = api.createStore(area);
  await first.setCaughtUp("YOU", item, true);
  const second = api.createStore(area);
  assert.equal((await second.listReviews("you")).get("acme/console#42").activity, api.activityToken(item));
  assert.equal((await second.listReviews("someone-else")).size, 0);
  await assert.rejects(second.listReviews(""), /username is unavailable/);
  await assert.rejects(second.setCaughtUp("you", { ...item, dateTime: "" }, true), /update time/);
  const newer = { ...item, dateTime: "2026-09-26T18:00:00Z" };
  await first.setCaughtUp("you", newer, true);
  await assert.rejects(second.setCaughtUp("you", item, true), /newer update/);
  await assert.rejects(second.setCaughtUp("you", item, false), /another tab/);
  assert.equal((await first.listReviews("you")).get("acme/console#42").activity, api.activityToken(newer));
  await first.setCaughtUp("you", newer, false);
  assert.equal((await first.listReviews("you")).size, 0);
});

test("source fingerprints change for every model input, target, version, and account distinction", async () => {
  const fingerprint = await api.sourceFingerprint(source);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await api.sourceFingerprint({ ...source, viewer: "YOU" }), fingerprint);
  for (const change of [
    { text: source.text + " Edited." }, { title: "New title" }, { author: "maya" },
    { viewer: "sam" }, { model: "another-model" }, { truncated: true },
    { dateTime: "2026-09-26T18:00:00Z" }, { href: item.href.replace("123", "124") }
  ]) assert.notEqual(await api.sourceFingerprint({ ...source, ...change }), fingerprint);
});

test("saved summaries require matching activity, target, account, model, version, and reuse age", async () => {
  const area = storage();
  const store = api.createStore(area);
  const saved = await record();
  await store.saveCachedSummary({ ...saved, text: source.text, unrelated: "not retained" });
  assert.deepEqual(await store.getCachedSummary("you", item, source.model), saved);
  assert.equal(await store.getCachedSummary("sam", item, source.model), null);
  assert.equal(await store.getCachedSummary("you", item, "another-model"), null);
  assert.equal(await store.getCachedSummary("you", { ...item, dateTime: "2026-09-26T18:00:00Z" }, source.model), null);
  assert.equal(await store.getCachedSummary("you", { ...item, dateTime: "" }, source.model), null);
  assert.equal(await store.getCachedSummary("you", { ...item, href: item.href.replace("123", "124") }, source.model), null);
  assert.deepEqual(await store.getCachedSummary("you", { href: item.href }, source.model, false), saved);
  assert.doesNotMatch(JSON.stringify(area.values), /full source is not saved|unrelated/);
  const key = api.cacheKey("you", "acme/console#42");
  area.values[key] = { ...saved, summaryVersion: summary.SUMMARY_VERSION + 1 };
  assert.equal(await store.getCachedSummary("you", item, source.model), null);
  area.values[key] = { ...saved, generatedAt: 1, checkedAt: Date.now() - api.CACHE_AGE_MS - 1 };
  assert.equal(await store.getCachedSummary("you", item, source.model), null);
});

test("cache pruning bounds storage and removes expired entries without touching unrelated data", async () => {
  const area = storage();
  const store = api.createStore(area);
  await store.add(["acme/console#42"]);
  await store.setCaughtUp("you", item, true);
  const saved = await record();
  for (let index = 1; index <= api.CACHE_LIMIT + 1; index++) {
    const other = { ...item, href: item.href.replace("/42#", `/${index}#`) };
    await store.saveCachedSummary({
      ...saved, href: other.href, activity: api.activityToken(other),
      generatedAt: saved.generatedAt - 1000, checkedAt: saved.checkedAt - 1000 + index
    });
  }
  assert.equal((await store.localDataCounts()).summaries, api.CACHE_LIMIT);
  assert.equal(area.values[api.cacheKey("you", "acme/console#1")], undefined);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.listReviews("you")).size, 1);
  area.values[api.cacheKey("you", "acme/console#2")].checkedAt = 1;
  await store.saveCachedSummary(saved);
  assert.equal(area.values[api.cacheKey("you", "acme/console#2")], undefined);
});

test("clear and unsubscribe keep settings intact and remove only the requested local data", async () => {
  const area = storage();
  const store = api.createStore(area);
  await store.add(["acme/console#42", "acme/console#99"]);
  await store.saveSummarySettings({ model: source.model, automatic: false });
  await store.setCaughtUp("you", item, true);
  await store.setCaughtUp("sam", item, true);
  await store.saveCachedSummary(await record());
  await store.clearLocalData("summaries");
  assert.deepEqual(await store.localDataCounts(), { summaries: 0, reviews: 2 });
  assert.equal(typeof area.values[api.CACHE_RESET_KEY], "string");
  await store.saveCachedSummary(await record());
  await store.remove(item.href);
  assert.deepEqual(await store.localDataCounts(), { summaries: 0, reviews: 0 });
  assert.deepEqual((await store.list()).map((entry) => entry.key), ["acme/console#99"]);
  assert.equal((await store.getSummarySettings()).model, source.model);
  await assert.rejects(store.clearLocalData("everything"), /Choose/);
});

test("corrupt state, wrong-account records, and storage write failures remain visible", async () => {
  const area = storage();
  const store = api.createStore(area);
  const key = api.cacheKey("you", "acme/console#42");
  area.values[key] = await record({ viewer: "someone-else", result: { summary: "FYI", action: "", response: "fyi", evidence: "" } });
  await assert.rejects(store.getCachedSummary("you", item, source.model), /account or item/);
  area.values[key] = await record({ result: { summary: "Missing fields" } });
  await assert.rejects(store.getCachedSummary("you", item, source.model), /saved summary is unreadable.*Clear saved/);
  area.values[api.reviewKey("you", "acme/console#42")] = {};
  await assert.rejects(store.listReviews("you"), /unreadable.*Reset caught-up/);
  await store.clearLocalData("reviews");
  assert.equal((await store.listReviews("you")).size, 0);
  area.set = async () => { throw new Error("Quota exceeded"); };
  await assert.rejects(store.saveCachedSummary(await record()), /Quota exceeded/);
  await assert.rejects(store.setCaughtUp("you", item, true), /Quota exceeded/);
});
