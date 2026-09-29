const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const summary = require("../summary.js");
const storeApi = require("../store.js");
const { createStore, isSubscriptionChange, isFilterChange, isSummaryChange } = require("../store.js");

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

test("persists, deduplicates, lists, and removes subscriptions", async () => {
  const area = storage();
  const store = createStore(area);
  assert.equal(await store.add(["acme/console#1", "acme/console#1"]), 1);
  assert.equal(await store.add(["/acme/console/pull/1"]), 0);
  const saved = await store.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, "acme/console#1");
  assert.ok(Number.isFinite(saved[0].savedAt));
  await store.remove("/acme/console/pull/1");
  assert.deepEqual(await store.list(), []);
});

test("simultaneous additions from separate tabs do not replace each other", async () => {
  const area = storage();
  const first = createStore(area);
  const second = createStore(area);
  await Promise.all([first.add(["acme/console#1"]), second.add(["acme/console#2"])]);
  assert.equal((await first.list()).length, 2);
});

test("one tab removing an item does not lose another tab's addition", async () => {
  const area = storage();
  const store = createStore(area);
  await store.add(["acme/console#1"]);
  await Promise.all([store.remove("acme/console#1"), store.add(["acme/console#2"])]);
  assert.deepEqual((await store.list()).map((item) => item.key), ["acme/console#2"]);
});

test("rejects an invalid batch before writing any entries", async () => {
  const area = storage();
  await assert.rejects(createStore(area).add(["acme/console#1", "https://evil.test"]), /supported/);
  assert.deepEqual(area.values, {});
});

test("reports storage failures and corrupt data instead of an empty list", async () => {
  const failed = createStore({ get: async () => { throw new Error("Storage unavailable"); } });
  await assert.rejects(failed.list(), /Storage unavailable/);
  const corrupt = storage({ [core.STORAGE_PREFIX + "acme/console#1"]: { url: "https://evil.test", savedAt: 1 } });
  await assert.rejects(createStore(corrupt).list(), /unreadable/);
  const quota = storage();
  quota.set = async () => { throw new Error("Quota exceeded"); };
  await assert.rejects(createStore(quota).add(["acme/console#1"]), /Quota exceeded/);
});

test("ignores unrelated extension settings and storage areas", async () => {
  assert.deepEqual(await createStore(storage({ theme: "dark" })).list(), []);
  assert.equal(isSubscriptionChange({ theme: {} }, "local"), false);
  assert.equal(isSubscriptionChange({ [core.STORAGE_PREFIX + "x"]: {} }, "sync"), false);
  assert.equal(isSubscriptionChange({ [core.STORAGE_PREFIX + "x"]: {} }, "local"), true);
});

test("migrates the filter without writing or changing existing subscriptions", async () => {
  const area = storage();
  const store = createStore(area);
  await store.add(["acme/console#1"]);
  const before = { ...area.values };
  assert.deepEqual(await store.getFilter(), { name: "Subscriptions", enabled: true });
  assert.deepEqual(area.values, before);
  await store.saveFilter({ name: " My priorities ", enabled: true });
  assert.deepEqual(await store.getFilter(), { name: "My priorities", enabled: true });
  assert.deepEqual((await store.list()).map((item) => item.key), ["acme/console#1"]);
  await store.saveFilter({ name: "My priorities", enabled: false });
  assert.equal((await store.getFilter()).enabled, false);
  assert.equal((await store.list()).length, 1);
});

test("rejects invalid filter settings and surfaces storage errors", async () => {
  const area = storage();
  const store = createStore(area);
  for (const value of [null, {}, { name: "", enabled: true }, { name: "a".repeat(41), enabled: true }, { name: "Valid", enabled: "yes" }]) {
    await assert.rejects(store.saveFilter(value));
  }
  assert.deepEqual(area.values, {});
  area.values[core.FILTER_STORAGE_KEY] = { enabled: true };
  await assert.rejects(store.getFilter(), /unreadable/);
  area.set = async () => { throw new Error("Storage unavailable"); };
  await assert.rejects(store.saveFilter(core.DEFAULT_FILTER), /Storage unavailable/);
});

test("filter changes are distinct from subscription list changes", () => {
  assert.equal(isFilterChange({ [core.FILTER_STORAGE_KEY]: {} }, "local"), true);
  assert.equal(isFilterChange({ [core.FILTER_STORAGE_KEY]: {} }, "sync"), false);
  assert.equal(isFilterChange({ unrelated: {} }, "local"), false);
  assert.equal(isSubscriptionChange({ [core.FILTER_STORAGE_KEY]: {} }, "local"), false);
});

test("local summaries are opt-in and do not change subscriptions or filter settings", async () => {
  const area = storage();
  const store = createStore(area);
  await store.add(["acme/console#1"]);
  await store.saveFilter({ name: "Important", enabled: true });
  const before = { ...area.values };
  assert.deepEqual(await store.getSummarySettings(), { model: "", automatic: false });
  assert.deepEqual(area.values, before);
  await store.saveSummarySettings({ model: "gemma4:12b-it-qat", automatic: false });
  assert.deepEqual(await store.getSummarySettings(), { model: "gemma4:12b-it-qat", automatic: false });
  assert.deepEqual(await store.getFilter(), { name: "Important", enabled: true });
  assert.deepEqual((await store.list()).map((item) => item.key), ["acme/console#1"]);
  await store.saveSummarySettings(summary.DEFAULT_SETTINGS);
  assert.equal((await store.list()).length, 1);
});

test("invalid summary settings fail visibly without persisting comment content", async () => {
  const area = storage();
  const store = createStore(area);
  await assert.rejects(store.saveSummarySettings({ model: "", automatic: true }));
  assert.deepEqual(area.values, {});
  area.values[summary.STORAGE_KEY] = { model: 42, automatic: true };
  await assert.rejects(store.getSummarySettings());
  await store.saveSummarySettings({ model: "gemma4:12b-it-qat", automatic: false, comment: "Private source", summary: "Do not store this" });
  assert.deepEqual(area.values[summary.STORAGE_KEY], { model: "gemma4:12b-it-qat", automatic: false });
  assert.equal(isSummaryChange({ [summary.STORAGE_KEY]: {} }, "local"), true);
  assert.equal(isSummaryChange({ [summary.STORAGE_KEY]: {} }, "sync"), false);
  assert.equal(isSubscriptionChange({ [summary.STORAGE_KEY]: {} }, "local"), false);
});
