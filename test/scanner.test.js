const test = require("node:test");
const assert = require("node:assert/strict");
const { createState, scan } = require("../scanner.js");
const base = "https://github.com/notifications";
const page = (next = null) => ({ items: [], rowCount: 25, unidentified: 0, next });

test("follows every page, including pages with no matching subscriptions", async () => {
  const state = createState(base);
  const requests = [];
  await scan(state, {
    signal: new AbortController().signal,
    delayMs: 0,
    loadPage: async (url) => {
      requests.push(url);
      return requests.length < 4 ? page(`?after=${requests.length + 1}`) : page();
    },
    onPage: () => {}
  });
  assert.deepEqual(requests, [base, base + "?after=2", base + "?after=3", base + "?after=4"]);
  assert.equal(state.rowCount, 100);
  assert.equal(state.pages, 4);
  assert.equal(state.complete, true);
  assert.equal(state.running, false);
});

test("pauses after committed pages and resumes at the next page", async () => {
  const state = createState(base);
  const controller = new AbortController();
  const requests = [];
  await assert.rejects(scan(state, {
    signal: controller.signal,
    delayMs: 0,
    loadPage: async (url) => { requests.push(url); return page("?after=2"); },
    onPage: () => controller.abort()
  }), { name: "AbortError" });
  assert.equal(state.pages, 1);
  assert.equal(state.complete, false);
  assert.equal(state.running, false);
  await scan(state, {
    signal: new AbortController().signal,
    delayMs: 0,
    loadPage: async (url) => { requests.push(url); return page(); },
    onPage: () => {}
  });
  assert.deepEqual(requests, [base, base + "?after=2"]);
  assert.equal(state.complete, true);
});

test("retries the failed page instead of skipping it", async () => {
  const state = createState(base);
  let failed = false;
  const requests = [];
  const options = {
    signal: new AbortController().signal,
    delayMs: 0,
    loadPage: async (url) => {
      requests.push(url);
      if (url === base) return page("?after=2");
      if (!failed) { failed = true; throw new Error("HTTP 429"); }
      return page();
    },
    onPage: () => {}
  };
  await assert.rejects(scan(state, options), /429/);
  assert.equal(state.next, base + "?after=2");
  assert.equal(state.complete, false);
  await scan(state, options);
  assert.deepEqual(requests, [base, base + "?after=2", base + "?after=2"]);
  assert.equal(state.pages, 2);
});

test("follows each repository group and its pagination once, including empty groups", async () => {
  const first = base + "?query=repo%3Aacme%2Fone";
  const next = first + "&after=2";
  const second = base + "?query=repo%3Aacme%2Ftwo";
  const pages = {
    [base]: { ...page(), additionalPages: [first, second, first] },
    [first]: { ...page(next), additionalPages: [second] },
    [next]: page(),
    [second]: { ...page(), rowCount: 0, additionalPages: [first] }
  };
  const state = createState(base);
  const requests = [];
  const completion = [];
  await scan(state, {
    signal: new AbortController().signal, delayMs: 0,
    loadPage: async (url) => { requests.push(url); return pages[url]; },
    onPage: () => completion.push(state.complete)
  });
  assert.deepEqual(requests, [base, first, next, second]);
  assert.deepEqual(completion, [false, false, false, true]);
  assert.deepEqual(state.pending, []);
  assert.equal(state.rowCount, 75);
});

test("retains queued repository groups through pause, failed requests, and retry", async () => {
  const first = base + "?query=repo%3Aacme%2Fone";
  const next = first + "&after=2";
  const second = base + "?query=repo%3Aacme%2Ftwo";
  const state = createState(base);
  const controller = new AbortController();
  const requests = [];
  await assert.rejects(scan(state, {
    signal: controller.signal, delayMs: 0,
    loadPage: async (url) => { requests.push(url); return { ...page(), additionalPages: [first, second] }; },
    onPage: () => controller.abort()
  }), { name: "AbortError" });
  assert.equal(state.next, first);
  assert.deepEqual(state.pending, [second]);
  await assert.rejects(scan(state, {
    signal: new AbortController().signal, delayMs: 0,
    loadPage: async (url) => { requests.push(url); throw new Error("HTTP 429"); },
    onPage: () => assert.fail("Failed requests must not consume queued pages")
  }), /429/);
  assert.equal(state.next, first);
  assert.deepEqual(state.pending, [second]);
  await scan(state, {
    signal: new AbortController().signal, delayMs: 0,
    loadPage: async (url) => { requests.push(url); return page(url === first ? next : null); },
    onPage: () => {}
  });
  assert.deepEqual(requests, [base, first, first, next, second]);
  assert.equal(state.pages, 4);
  assert.equal(state.complete, true);
});

test("rejects unsafe, malformed, or self-referencing group pages before committing progress", async () => {
  for (const additionalPages of [["https://evil.test/notifications"], ["/logout"], [base], "not a list"]) {
    const state = createState(base);
    let requests = 0;
    await assert.rejects(scan(state, {
      signal: new AbortController().signal, delayMs: 0,
      loadPage: async () => { requests++; return { ...page(), additionalPages }; },
      onPage: () => assert.fail("An invalid group must not count as a completed page")
    }), /unsafe|unreadable|repeated/i);
    assert.equal(requests, 1);
    assert.equal(state.pages, 0);
    assert.equal(state.next, base);
    assert.equal(state.complete, false);
  }
});

test("does not accept late responses after cancellation", async () => {
  const state = createState(base);
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(scan(state, {
    signal: controller.signal,
    delayMs: 0,
    loadPage: async () => { controller.abort(); return page(); },
    onPage: () => count++
  }), { name: "AbortError" });
  assert.equal(count, 0);
  assert.equal(state.pages, 0);
  assert.equal(state.complete, false);
});

test("blocks offsite and non-notification pagination before requesting them", async () => {
  for (const next of ["https://evil.test/notifications", "/logout", "/acme/console/issues/1"]) {
    const state = createState(base);
    let requests = 0;
    await assert.rejects(scan(state, {
      signal: new AbortController().signal,
      delayMs: 0,
      loadPage: async () => { requests++; return page(next); },
      onPage: () => assert.fail("Unsafe page must not be accepted")
    }), /unsafe/i);
    assert.equal(requests, 1);
    assert.equal(state.complete, false);
  }
});

test("detects pagination loops and refuses overlapping scans", async () => {
  const state = createState(base);
  await assert.rejects(scan(state, {
    signal: new AbortController().signal,
    delayMs: 0,
    loadPage: async () => page(base),
    onPage: () => {}
  }), /repeated/);
  assert.equal(state.pages, 1);
  state.running = true;
  await assert.rejects(scan(state, { signal: new AbortController().signal }), /already running/);
});

test("aborting the throttle wait stops further requests", async () => {
  const state = createState(base);
  const controller = new AbortController();
  let requests = 0;
  const promise = scan(state, {
    signal: controller.signal,
    delayMs: 10000,
    loadPage: async () => { requests++; return page("?after=2"); },
    onPage: () => setTimeout(() => controller.abort(), 10)
  });
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(requests, 1);
  assert.equal(state.running, false);
});
