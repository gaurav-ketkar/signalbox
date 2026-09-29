const test = require("node:test");
const assert = require("node:assert/strict");
const { request } = require("../summary-client.js");

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (value) => [...listeners].forEach((listener) => listener(value)),
    size: () => listeners.size
  };
}

function connection() {
  const port = {
    onMessage: event(), onDisconnect: event(), sent: [], closed: false,
    postMessage(message) { this.sent.push(message); },
    disconnect() { this.closed = true; this.onDisconnect.emit(); }
  };
  const runtime = {
    connect(options) {
      assert.equal(options.name, "gns:local-summary");
      return port;
    }
  };
  return { port, runtime };
}

test("delivers progress and a result, then releases its port and listeners", async () => {
  const { port, runtime } = connection();
  const progress = [];
  const promise = request({ type: "models" }, { runtime, onProgress: (message) => progress.push(message) });
  assert.deepEqual(port.sent, [{ type: "models" }]);
  port.onMessage.emit({ type: "progress", message: "Working locally" });
  port.onMessage.emit({ type: "result", value: [{ id: "local", size: 100 }] });
  assert.deepEqual(await promise, [{ id: "local", size: 100 }]);
  assert.deepEqual(progress, ["Working locally"]);
  assert.equal(port.closed, true);
  assert.equal(port.onMessage.size(), 0);
  assert.equal(port.onDisconnect.size(), 0);
});

test("cancels a local request and ignores late results", async () => {
  const { port, runtime } = connection();
  const controller = new AbortController();
  const promise = request({ type: "summarize" }, { runtime, signal: controller.signal });
  controller.abort(new Error("Left the notification view"));
  await assert.rejects(promise, /Left the notification view/);
  port.onMessage.emit({ type: "result", value: "stale" });
  assert.equal(port.closed, true);
});

test("does not open a port for an already-cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request({}, {
    signal: controller.signal,
    runtime: { connect() { assert.fail("Cancelled request opened a port"); } }
  }), { name: "AbortError" });
});

test("surfaces worker errors, unexpected responses, and disconnected extensions", async () => {
  for (const response of [{ type: "error", message: "Ollama is unavailable" }, { type: "unexpected" }]) {
    const { port, runtime } = connection();
    const promise = request({ type: "models" }, { runtime });
    port.onMessage.emit(response);
    await assert.rejects(promise, /Ollama|unreadable/);
    assert.equal(port.closed, true);
  }
  const { port, runtime } = connection();
  const promise = request({ type: "models" }, { runtime });
  runtime.lastError = { message: "Extension context invalidated" };
  port.onDisconnect.emit();
  await assert.rejects(promise, /Extension context invalidated/);
});

test("keeps the MV3 worker alive during inference and stops heartbeats on completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { port, runtime } = connection();
  const promise = request({ type: "summarize" }, { runtime });
  t.mock.timers.tick(15000);
  assert.deepEqual(port.sent, [{ type: "summarize" }, { type: "ping" }]);
  port.onMessage.emit({ type: "result", value: { summary: "Done", action: "" } });
  await promise;
  t.mock.timers.tick(15000);
  assert.equal(port.sent.length, 2);
});

test("times out a stalled connection without leaving an active port", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { port, runtime } = connection();
  const promise = request({ type: "summarize" }, { runtime });
  t.mock.timers.tick(180001);
  await assert.rejects(promise, /too long/);
  assert.equal(port.closed, true);
  assert.equal(port.onMessage.size(), 0);
});
