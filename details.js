(function exposeDetails(root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.GitHubSubscriptions;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionDetails = api;
})(globalThis, function createDetailsApi(core) {
  "use strict";

  // Fills in titles and open/closed states for saved items from GitHub's small
  // hovercards, the same cards github.com shows when you hover an item link.
  const TITLE_RETRY_MS = 24 * 60 * 60 * 1000;
  const STATE_RECHECK_MS = 12 * 60 * 60 * 1000;
  const CARD_TYPES = new Set(["issue", "pull", "discussion", "commit"]);

  class DetailsError extends Error {
    // stop: GitHub is busy or unreachable, so end this run without recording a
    // check and try again later. Otherwise this one item is skipped for a day.
    constructor(message, { stop = false, cause } = {}) {
      super(message, { cause });
      this.name = "DetailsError";
      this.stop = stop;
    }
  }

  function hovercardUrl(item) {
    const parsed = core.parseItem(item?.url);
    return parsed && CARD_TYPES.has(parsed.type) ? `${parsed.url}/hovercard` : "";
  }

  function readHovercard(document, item) {
    const parsed = core.parseItem(item?.url);
    if (!parsed) return null;
    for (const anchor of document.querySelectorAll("a.Link--primary[href]")) {
      if (core.parseItem(anchor.getAttribute("href"))?.key !== parsed.key) continue;
      const title = core.cleanText((anchor.querySelector("h4, h5") || anchor).textContent, 300);
      if (!title) continue;
      let state = "";
      if (parsed.type === "issue" || parsed.type === "pull") {
        // The status badge sits beside the title link, never far above it.
        for (let node = anchor.parentElement, depth = 0; node && depth < 3 && !state; node = node.parentElement, depth += 1) {
          state = core.normalizeState(node.querySelector(".State[title^='Status:']")?.getAttribute("title"));
        }
      }
      return { title: title === parsed.label ? "" : title, state };
    }
    return null;
  }

  async function load(item, { signal, fetchPage = fetch, parse = (html) => new DOMParser().parseFromString(html, "text/html") } = {}) {
    const parsed = core.parseItem(item?.url);
    const url = hovercardUrl(parsed);
    if (!url) throw new DetailsError("GitHub has no card for this kind of item.");
    const timeout = AbortSignal.timeout(20000);
    let response;
    try {
      response = await fetchPage(url, {
        method: "GET",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        // Transferred repositories answer with a redirect to the new location.
        redirect: "follow",
        cache: "no-store",
        headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DetailsError("GitHub could not be reached.", { stop: true, cause: error });
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DetailsError(`GitHub is busy (HTTP ${response.status}).`, { stop: true });
    }
    if (!response.ok) throw new DetailsError(`GitHub has no card for this item (HTTP ${response.status}).`);
    const final = core.githubUrl(response.url || url);
    if (!final || !final.pathname.endsWith("/hovercard")) {
      throw new DetailsError("GitHub sent the card request somewhere else. Sign in to GitHub again.", { stop: true });
    }
    if (!response.headers.get("content-type")?.includes("text/html")) throw new DetailsError("GitHub did not return a card.");
    const html = await response.text();
    signal?.throwIfAborted();
    const document = parse(html);
    const moved = core.parseItem(final.pathname.slice(0, -"/hovercard".length));
    const details = (moved && readHovercard(document, moved)) || readHovercard(document, parsed);
    if (!details) throw new DetailsError("GitHub's card did not name this item.");
    return details;
  }

  // Missing titles are retried daily. Open issues and pull requests are
  // rechecked twice a day so closed ones move to the closed group.
  function needsDetails(record, now = Date.now()) {
    const parsed = core.parseItem(record?.url);
    if (!parsed || !CARD_TYPES.has(parsed.type)) return false;
    const age = now - (Number.isFinite(record.checkedAt) ? record.checkedAt : 0);
    if (!record.title) return age >= TITLE_RETRY_MS;
    if (parsed.type !== "issue" && parsed.type !== "pull") return false;
    return record.state !== "closed" && record.state !== "merged" && age >= STATE_RECHECK_MS;
  }

  function candidates(records, now = Date.now()) {
    return records.filter((record) => needsDetails(record, now)).sort((a, b) =>
      Number(Boolean(a.title)) - Number(Boolean(b.title)) ||
      (a.checkedAt || 0) - (b.checkedAt || 0) ||
      (b.savedAt || 0) - (a.savedAt || 0));
  }

  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Checks one paced round: two cards at a time with a short pause between
  // requests, saving every few results so progress survives closing the tab.
  // `latest` returns the freshest copy of a record, so items another tab or a
  // notification row already filled in are skipped. Items in `tried` are not
  // retried in this tab. `more` says whether another round has work to do.
  async function backfill(records, {
    signal, save, loadCard = load, latest = (record) => record, tried = new Set(), now = Date.now(),
    limit = 50, workers = 2, gapMs = 150, batchSize = 10
  }) {
    const waiting = candidates(records, now).filter((record) => !tried.has(record.key));
    const queue = waiting.slice(0, limit);
    const results = [];
    let checked = 0;
    let stopped = null;
    const flush = async () => {
      const batch = results.splice(0);
      if (batch.length) await save(batch);
    };
    const worker = async () => {
      while (queue.length && !stopped) {
        signal.throwIfAborted();
        const queued = queue.shift();
        tried.add(queued.key);
        const record = latest(queued);
        if (!record || !needsDetails(record, Date.now())) continue;
        try {
          results.push({ url: record.url, ...await loadCard(record, { signal }), checked: true });
        } catch (error) {
          if (signal.aborted) throw error;
          if (error?.stop) {
            stopped = error;
            return;
          }
          results.push({ url: record.url, checked: true });
        }
        checked += 1;
        if (results.length >= batchSize) await flush();
        if (queue.length && !stopped) await wait(gapMs, signal);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
    } finally {
      await flush();
    }
    return { checked, stopped, more: !stopped && waiting.length > limit };
  }

  return {
    DetailsError, hovercardUrl, readHovercard, load, needsDetails, candidates, backfill, wait,
    TITLE_RETRY_MS, STATE_RECHECK_MS
  };
});
