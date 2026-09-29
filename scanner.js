(function exposeScanner(root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.GitHubSubscriptions;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionScanner = api;
})(globalThis, function createScannerApi(core) {
  "use strict";

  function createState(url) {
    const next = core.notificationPageUrl(url);
    if (!next) throw new Error("The scan must start on GitHub's notifications page.");
    return { next, pending: [], visited: new Set(), pages: 0, rowCount: 0, unidentified: 0, complete: false, running: false };
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

  async function scan(state, { loadPage, onPage, signal, delayMs = 350 }) {
    if (state.running) throw new Error("A notification scan is already running.");
    state.running = true;
    try {
      while (state.next) {
        signal.throwIfAborted();
        const url = core.notificationPageUrl(state.next);
        if (!url) throw new Error("An unsafe pagination URL was blocked.");
        if (state.visited.has(url)) throw new Error("GitHub repeated a notification page. Refresh to start a new search.");
        const page = await loadPage(url, signal);
        signal.throwIfAborted();
        const next = page.next ? core.notificationPageUrl(page.next, url) : null;
        if (page.next && !next) throw new Error("An unsafe pagination URL was blocked.");
        if (page.additionalPages !== undefined && !Array.isArray(page.additionalPages)) {
          throw new Error("GitHub returned an unreadable list of repository-group pages.");
        }
        const additionalPages = (page.additionalPages || []).map((value) => core.notificationPageUrl(value, url));
        if (additionalPages.some((value) => !value)) throw new Error("An unsafe repository-group URL was blocked.");
        if (additionalPages.includes(url)) throw new Error("GitHub repeated a repository-group page. The search is incomplete.");
        if (!Array.isArray(page.items) || !Number.isInteger(page.rowCount) || page.rowCount < 0) {
          throw new Error("GitHub returned an unreadable notifications page.");
        }
        const pending = [...new Set([...state.pending, ...additionalPages])]
          .filter((value) => value !== next && !state.visited.has(value));
        state.visited.add(url);
        state.pages += 1;
        state.rowCount += page.rowCount;
        state.unidentified += page.unidentified || 0;
        state.next = next || pending.shift() || null;
        state.pending = pending;
        state.complete = !state.next;
        onPage(page, state);
        if (state.next && delayMs > 0) await wait(delayMs, signal);
      }
    } finally {
      state.running = false;
    }
    return state;
  }

  return { createState, scan };
});
