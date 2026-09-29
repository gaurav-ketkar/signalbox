(function exposeSummaryClient(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionSummaryClient = api;
})(globalThis, function createSummaryClient() {
  "use strict";

  function request(message, { signal, onProgress = () => {}, runtime = chrome.runtime } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let port;
      try {
        port = runtime.connect({ name: "gns:local-summary" });
      } catch (error) {
        reject(error);
        return;
      }
      let finished = false;
      const heartbeat = setInterval(() => {
        try {
          port.postMessage({ type: "ping" });
        } catch (error) {
          finish(error);
        }
      }, 15000);
      const timeout = setTimeout(() => finish(new Error("The local summary took too long. Check your local model server, then retry.")), 180000);

      function finish(error, value) {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        port.onMessage.removeListener(receive);
        port.onDisconnect.removeListener(disconnect);
        port.disconnect();
        if (error) reject(error);
        else resolve(value);
      }
      function abort() {
        finish(signal.reason);
      }
      function disconnect() {
        const detail = runtime.lastError?.message;
        finish(new Error(detail || "The local summary connection closed. Refresh this tab and retry."));
      }
      function receive(response) {
        if (response?.type === "progress") onProgress(response.message);
        else if (response?.type === "result") finish(null, response.value);
        else finish(new Error(response?.message || "The local model returned an unreadable response. Retry the summary."));
      }
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(disconnect);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        port.postMessage(message);
      } catch (error) {
        finish(error);
      }
    });
  }

  return { request };
});
