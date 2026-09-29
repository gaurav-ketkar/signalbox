const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const preview = require("../preview.js");

const target = core.commentTarget("/acme/console/pull/42?notification_referrer_id=demo#issuecomment-123");
const missingDocument = { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] };
const htmlResponse = () => new Response("<main></main>", { headers: { "content-type": "text/html" } });

test("preview requests use same-origin GET without tracking or redirects", async () => {
  let request;
  const result = await preview.load(target, {
    signal: new AbortController().signal,
    fetchPage: async (url, options) => { request = { url, options }; return htmlResponse(); },
    parse: () => missingDocument
  });
  assert.equal(result, null);
  assert.equal(request.url, "https://github.com/acme/console/pull/42");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.equal(request.options.redirect, "error");
});

test("invalid preview targets never fetch a page", async () => {
  let fetched = false;
  for (const value of [null, { ...target, url: "https://other.test/" }, { ...target, id: "top" }, { ...target, key: "other/repo#42" }]) {
    await assert.rejects(preview.load(value, {
      signal: new AbortController().signal,
      fetchPage: async () => { fetched = true; return htmlResponse(); }
    }), /supported comment/);
  }
  assert.equal(fetched, false);
});

test("preview errors are explicit rather than successful empty comments", async () => {
  const signal = new AbortController().signal;
  for (const status of [403, 404, 429, 500]) {
    await assert.rejects(preview.load(target, {
      signal,
      fetchPage: async () => new Response("", { status, headers: { "content-type": "text/html" } })
    }), status === 429 ? /rate-limited/ : new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(preview.load(target, { signal, fetchPage: async () => new Response("{}") }), /item page/);
});

test("summary fallback extracts React embeddedData JSON or thread content when exact anchor is absent", async () => {
  const threadTarget = core.summaryTarget("/acme/console/issues/11");
  assert.deepEqual(threadTarget, { id: "thread", url: "https://github.com/acme/console/issues/11", key: "acme/console#11" });
  const reactHtml = `<!doctype html><html><body>
    <script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
      payload: {
        issue: {
          title: "Tighten release checklist",
          number: 11,
          state: "OPEN",
          author: { login: "maya" },
          createdAt: "2026-09-25T16:00:00Z",
          body: "We need a pre-release verification step."
        },
        comments: [
          {
            databaseId: 999,
            author: { login: "sam" },
            createdAt: "2026-09-25T17:00:00Z",
            body: "@you please confirm the smoke test checklist."
          }
        ]
      }
    })}</script>
  </body></html>`;
  const doc = {
    querySelector: () => null,
    getElementById: () => null,
    querySelectorAll: (selector) => selector.includes("embeddedData") ? [{ textContent: reactHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1] }] : []
  };
  const extracted = await preview.load(threadTarget, {
    signal: new AbortController().signal,
    allowFallback: true,
    fetchPage: async () => new Response(reactHtml, { headers: { "content-type": "text/html" } }),
    parse: () => doc
  });
  assert.equal(extracted.author, "sam");
  assert.match(extracted.text, /pre-release verification step/);
  assert.match(extracted.text, /smoke test checklist/);
});
