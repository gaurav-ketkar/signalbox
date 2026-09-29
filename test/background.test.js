const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../core.js");
const summaryApi = require("../summary.js");
const storeApi = require("../store.js");

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.map((listener) => listener(...args))
  };
}

function harness() {
  const id = "test-extension";
  const state = {
    allowed: true, model: "local-model", subscribed: true, calls: [], waits: [], hold: false, active: 0, peak: 0
  };
  const chrome = {
    runtime: {
      id, getURL: (file) => `chrome-extension://${id}/${file}`,
      onMessage: event(), onConnect: event(), onStartup: event(), onInstalled: event(), openOptionsPage: async () => {}
    },
    permissions: { contains: async () => state.allowed },
    tabs: { create: async () => {} },
    storage: { local: {}, onChanged: event() }
  };
  const summary = {
    ...summaryApi,
    PERMISSION_ORIGIN: "http://127.0.0.1/*",
    listModels: async () => {
      state.calls.push("models");
      return [{ id: state.model, size: 100 }];
    },
    summarize: async (input, { signal }) => {
      state.calls.push(input);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        if (state.hold) await new Promise((resolve, reject) => {
          state.waits.push(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { summary: "A useful summary.", action: "", response: "fyi", evidence: "" };
      } finally {
        state.active--;
      }
    }
  };
  const values = {};
  chrome.storage.local = {
    get: async (keys) => keys === null ? { ...values } :
      Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]])),
    set: async (updates) => { Object.assign(values, updates); },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  };
  const store = {
    ...storeApi.createStore(chrome.storage.local),
    getSummarySettings: async () => ({ model: state.model, automatic: false }),
    list: async () => state.subscribed ? [{ key: "acme/console#42" }] : []
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), {
    chrome, console, AbortController, importScripts() {},
    GitHubSubscriptions: core, GitHubSubscriptionSummary: summary,
    GitHubSubscriptionStore: {
      ...storeApi,
      createStore: () => store,
      isSummaryChange: (changes) => Object.hasOwn(changes, "summaries:v1:settings")
    }
  });
  const sender = { id, url: "https://github.com/notifications#subscriptions", frameId: 0, tab: { id: 7 } };
  const ports = [];
  function connect(overrides = {}) {
    const port = {
      name: "gns:local-summary", sender: { ...sender, ...overrides },
      onMessage: event(), onDisconnect: event(), messages: [], closed: false,
      postMessage(value) { this.messages.push(value); },
      disconnect() { this.closed = true; this.onDisconnect.emit(); }
    };
    ports.push(port);
    chrome.runtime.onConnect.emit(port);
    return port;
  }
  return {
    state, chrome, connect, values, store,
    send: (message, overrides = {}) => new Promise((resolve) => {
      const accepted = chrome.runtime.onMessage.emit(message, { ...sender, ...overrides }, resolve);
      if (!accepted.some(Boolean)) resolve({ ok: false, error: "Message rejected" });
    }),
    close: () => ports.forEach((port) => port.disconnect())
  };
}

const input = {
  type: "summarize", model: "local-model",
  href: "https://github.com/acme/console/pull/42#issuecomment-123",
  title: "Keyboard fix", author: "ada", viewer: "you", text: "Please review the fix.", truncated: false
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "The expected asynchronous worker state was not reached");
}

test("rejects foreign senders, frames, and non-notification pages", () => {
  const h = harness();
  for (const sender of [
    { id: "other-extension" }, { frameId: 2 }, { url: "https://evil.test/notifications" },
    { url: "https://github.com.evil.test/notifications" }, { url: "/notifications" },
    { url: "https://github.com/acme/console/issues/42" }, { url: "chrome-extension://test-extension/manager.html.evil" }
  ]) assert.equal(h.connect(sender).closed, true);
  assert.deepEqual(h.state.calls, []);
  h.close();
});

test("permits model discovery but not source summarization from the settings page", async () => {
  const h = harness();
  const manager = h.connect({ url: "chrome-extension://test-extension/manager.html#summaries" });
  manager.onMessage.emit({ type: "models" });
  await tick();
  assert.equal(manager.messages.at(-1).type, "result");
  const forbidden = h.connect({ url: "chrome-extension://test-extension/manager.html" });
  forbidden.onMessage.emit(input);
  assert.equal(forbidden.messages.at(-1).type, "error");
  assert.deepEqual(h.state.calls, ["models"]);
  h.close();
});

test("rejects unsafe targets and oversized source before calling the local model", async () => {
  const h = harness();
  for (const change of [
    { href: "http://127.0.0.1/private" }, { href: "https://github.com/acme/console/pull/42" },
    { text: "a".repeat(12001) }, { author: {} }, { title: null }, { truncated: "yes" }
  ]) {
    const port = h.connect();
    port.onMessage.emit({ ...input, ...change });
    assert.equal(port.messages.at(-1).type, "error");
  }
  await tick();
  assert.deepEqual(h.state.calls, []);
  h.close();
});

test("checks host access and current model before inference and allows summarizing non-subscribed notifications", async () => {
  for (const [key, value] of [["allowed", false], ["model", "different-model"]]) {
    const h = harness();
    h.state[key] = value;
    const port = h.connect();
    port.onMessage.emit(input);
    await tick();
    assert.equal(port.messages.at(-1).type, "error");
    assert.deepEqual(h.state.calls, []);
    h.close();
  }
  const h = harness();
  h.state.subscribed = false;
  const port = h.connect({ url: "https://github.com/notifications?query=reason%3Amention" });
  port.onMessage.emit(input);
  await waitFor(() => port.messages.some((message) => message.type === "result"));
  assert.equal(port.messages.at(-1).type, "result");
  assert.equal(h.state.calls.length, 1);
  h.close();
});

test("processes notifications in parallel up to the LLM context window limit and releases capacity on disconnect", async () => {
  const h = harness();
  h.state.hold = true;
  // 1M context window / 20k tokens per notification = 50 in parallel
  const ports = Array.from({ length: 52 }, (_, i) => h.connect({ tab: { id: i + 1 } }));
  ports.forEach((port, i) => {
    port.onMessage.emit({
      ...input,
      href: `https://github.com/acme/console/pull/${i + 1}#issuecomment-123`,
      tokens: 20000,
      contextWindow: 1000000
    });
  });
  await waitFor(() => h.state.active === 50);
  assert.equal(h.state.calls.length, 50);
  assert.equal(h.state.peak, 50);
  // Disconnecting one active job frees 20k tokens in the context window and immediately admits job 51
  ports[0].disconnect();
  await waitFor(() => h.state.calls.length === 51);
  assert.equal(h.state.active, 50);
  // Completing one active job frees another 20k tokens and admits job 52
  h.state.waits[1]();
  await waitFor(() => h.state.calls.length === 52);
  for (const resolve of h.state.waits.slice(2)) resolve();
  await waitFor(() => ports[51].messages.some((message) => message.type === "result"));
  assert.equal(ports[51].messages.at(-1).type, "result");
  assert.equal(ports[0].messages.some((message) => message.type === "result"), false);
  h.close();
});

test("caps queued work and aborts active and queued jobs on settings changes", async () => {
  const h = harness();
  h.state.hold = true;
  const ports = Array.from({ length: 129 }, () => h.connect());
  for (const port of ports) port.onMessage.emit({ ...input, tokens: 20000, contextWindow: 20000 });
  await waitFor(() => h.state.active === 1);
  assert.match(ports[128].messages.at(-1).message, /Too many/);
  h.chrome.storage.onChanged.emit({ "summaries:v1:settings": { newValue: {} } }, "local");
  await tick();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.active, 0);
  assert.ok(ports.slice(0, 128).every((port) => port.messages.some((message) => message.type === "error")));
  h.close();
});

test("removing a subscription aborts its model job", async () => {
  const h = harness();
  h.state.hold = true;
  const port = h.connect();
  port.onMessage.emit(input);
  await waitFor(() => h.state.active === 1);
  h.chrome.storage.onChanged.emit({ [core.STORAGE_PREFIX + "acme/console#42"]: { oldValue: {} } }, "local");
  await tick();
  assert.equal(h.state.active, 0);
  assert.equal(port.messages.at(-1).type, "error");
  h.close();
});

test("reuses a matching source without another inference and invalidates changed input", async () => {
  const h = harness();
  for (let index = 0; index < 2; index++) {
    const port = h.connect();
    port.onMessage.emit(input);
    await waitFor(() => port.messages.some((message) => ["result", "error"].includes(message.type)));
    assert.equal(port.messages.at(-1).type, "result");
    assert.equal(port.messages.at(-1).value.reused, index > 0);
  }
  assert.equal(h.state.calls.length, 1);
  const changed = h.connect();
  changed.onMessage.emit({ ...input, text: "A new source comment revision." });
  await waitFor(() => changed.messages.some((message) => ["result", "error"].includes(message.type)));
  assert.equal(changed.messages.at(-1).type, "result");
  assert.equal(h.state.calls.length, 2);
  assert.equal((await h.store.localDataCounts()).summaries, 1);
  assert.doesNotMatch(JSON.stringify(h.values), /source comment revision/);
  h.close();
});

test("clearing summaries cancels inference and a late model result cannot restore the cache", async () => {
  const h = harness();
  h.state.hold = true;
  const port = h.connect();
  port.onMessage.emit(input);
  await waitFor(() => h.state.active === 1);
  const response = await h.send({ type: "gns:clear-local-data", kind: "summaries" },
    { url: "chrome-extension://test-extension/manager.html" });
  assert.equal(response.ok, true);
  h.state.waits[0]();
  await tick();
  assert.equal(h.state.active, 0);
  assert.equal((await h.store.localDataCounts()).summaries, 0);
  assert.equal(port.messages.some((message) => message.type === "result"), false);
  h.close();
});

test("a clear waits for an in-flight storage write and then removes the saved result", async () => {
  const h = harness();
  let release;
  let saving = false;
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (updates) => {
    if (Object.keys(updates).some((key) => key.startsWith(storeApi.CACHE_PREFIX))) {
      saving = true;
      await new Promise((resolve) => { release = resolve; });
    }
    return originalSet(updates);
  };
  const port = h.connect();
  port.onMessage.emit(input);
  await waitFor(() => saving);
  assert.equal(saving, true);
  const cleared = h.send({ type: "gns:clear-local-data", kind: "summaries" },
    { url: "chrome-extension://test-extension/manager.html" });
  release();
  assert.equal((await cleared).ok, true);
  await tick();
  assert.equal((await h.store.localDataCounts()).summaries, 0);
  assert.equal(port.messages.some((message) => message.type === "result"), false);
  h.close();
});

test("local-state actions enforce the sender boundary, account, and subscription", async () => {
  const h = harness();
  const item = { href: input.href, title: input.title, dateTime: "2026-09-25T18:00:00Z", state: "" };
  const message = { type: "gns:set-caught-up", viewer: "you", item, caughtUp: true };
  for (const sender of [
    { id: "someone-else" }, { frameId: 2 }, { url: "https://evil.test/notifications" },
    { url: "chrome-extension://test-extension/manager.html" }
  ]) assert.equal((await h.send(message, sender)).ok, false);
  assert.equal((await h.send({ ...message, viewer: "" })).ok, false);
  assert.equal((await h.send({ type: "gns:clear-local-data", kind: "summaries" })).ok, false);
  assert.equal((await h.send(message)).ok, true);
  assert.equal((await h.store.listReviews("you")).size, 1);
  h.state.subscribed = false;
  assert.equal((await h.send(message)).ok, false);
  h.close();
});
