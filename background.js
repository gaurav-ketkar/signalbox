"use strict";

importScripts("core.js", "summary.js", "store.js");

const core = globalThis.GitHubSubscriptions;
const summary = globalThis.GitHubSubscriptionSummary;
const storeApi = globalThis.GitHubSubscriptionStore;
const store = storeApi.createStore(chrome.storage.local);
const MAX_QUEUED_JOBS = 128;
const jobs = new Set();
const queue = [];
let drainScheduled = false;

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(() => {
    drainScheduled = false;
    drain();
  }, 0);
}
const knownContextWindows = new Map();
let activeJobs = 0;
let activeTokens = 0;
let stateTail = Promise.resolve();

// Content scripts keep the last inbox scan in memory-only session storage so page loads can skip a full rescan.
function shareSessionStorage() {
  if (chrome.runtime?.getManifest?.()?.name === "GitHub Notification Subscriptions") {
    chrome.runtime.reload?.();
    return;
  }
  chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
}
shareSessionStorage();
chrome.runtime.onStartup.addListener(shareSessionStorage);
chrome.runtime.onInstalled.addListener(shareSessionStorage);

async function writeState(action) {
  const previous = stateTail;
  let release;
  stateTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

async function localAction(message, page, senderUrl = "") {
  if (message.type === "gns:clear-local-data") {
    if (page !== "manager" || !["summaries", "reviews"].includes(message.kind)) {
      throw new Error("Use AI settings to clear saved summaries or caught-up state.");
    }
    if (message.kind === "summaries") {
      for (const job of jobs) {
        if (!job.key) continue;
        job.send({ type: "error", message: "Saved summaries were cleared. Request a summary again when ready." });
        job.controller.abort();
      }
    }
    return writeState(() => store.clearLocalData(message.kind));
  }
  if (page !== "notifications" || !core.normalizeLogin(message.viewer)) {
    throw new Error("Open your signed-in GitHub notifications to change local review state.");
  }
  const item = core.parseItem(message.item?.href);
  if (!item) throw new Error("This notification could not be identified.");
  return writeState(async () => {
    if (message.type === "gns:set-caught-up") {
      if (core.isSubscriptionView(senderUrl) && !(await store.list()).some((entry) => entry.key === item.key)) {
        throw new Error("This item is no longer in your subscription list.");
      }
      await store.setCaughtUp(message.viewer, message.item, message.caughtUp);
    } else {
      await store.deleteCachedSummary(message.viewer, message.item.href);
    }
  });
}

function senderPage(sender) {
  if (sender.id !== chrome.runtime.id) return "";
  if (sender.url === chrome.runtime.getURL("manager.html") ||
      sender.url?.startsWith(chrome.runtime.getURL("manager.html") + "?") ||
      sender.url?.startsWith(chrome.runtime.getURL("manager.html") + "#")) return "manager";
  if (sender.frameId === 0 && sender.tab && sender.url?.startsWith(core.ORIGIN + "/") &&
      core.isNotifications(sender.url)) return "notifications";
  return "";
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  let opening;
  if (message?.type === "gns:open-manager") opening = chrome.runtime.openOptionsPage();
  else if (message?.type === "gns:open-summary-settings" && senderPage(sender)) {
    opening = chrome.tabs.create({ url: chrome.runtime.getURL("manager.html#summaries") });
  } else if (message?.type === "gns:get-local-priority-rules" && senderPage(sender)) {
    opening = (async () => {
      if (typeof fetch !== "function") return core.DEFAULT_PRIORITY_RULES;
      try {
        const res = await fetch(chrome.runtime.getURL("priority-config.local.json"));
        if (res?.ok) return core.validatePriorityRules(await res.json());
      } catch {
        // Optional gitignored priority-config.local.json is absent in public checkouts.
      }
      return core.DEFAULT_PRIORITY_RULES;
    })();
  } else if (["gns:set-caught-up", "gns:discard-summary", "gns:clear-local-data"].includes(message?.type)) {
    opening = localAction(message, senderPage(sender), sender.url);
  } else return false;
  opening.then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: error.message })
  );
  return true;
});

function drain() {
  queue.sort((left, right) => (right.priority || 0) - (left.priority || 0));
  while (queue.length) {
    const job = queue[0];
    if (job.controller.signal.aborted) {
      queue.shift();
      continue;
    }
    const contextWindow = job.contextWindow || knownContextWindows.get(job.model) ||
      (summary.contextWindowForModel ? summary.contextWindowForModel(job.model) : 131072);
    const tokens = job.tokens || (summary.estimateTokens ? summary.estimateTokens(job.source) : 2000);
    const maxParallel = summary.maxParallelSummaries ?
      summary.maxParallelSummaries(contextWindow, tokens, job.model) :
      Math.max(1, Math.min(64, Math.floor(contextWindow / tokens)));
    if (activeJobs > 0 && (activeTokens + tokens > contextWindow || activeJobs >= maxParallel)) {
      break;
    }
    queue.shift();
    job.started = true;
    activeJobs += 1;
    activeTokens += tokens;
    void job.run().finally(() => {
      job.release();
      drain();
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "gns:local-summary") return;
  const page = senderPage(port.sender);
  if (!page) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  let closed = false;
  let received = false;
  let released = false;
  const job = {
    controller,
    key: "",
    model: "",
    priority: 0,
    tokens: 0,
    contextWindow: 0,
    source: null,
    started: false,
    send,
    run: null,
    release() {
      if (!this.started || released) return;
      released = true;
      activeJobs = Math.max(0, activeJobs - 1);
      activeTokens = Math.max(0, activeTokens - this.tokens);
    }
  };

  function send(message) {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch (error) {
      console.warn("Local summary connection was lost:", error.message);
      closed = true;
      controller.abort();
      jobs.delete(job);
      job.release();
      drain();
    }
  }
  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
    jobs.delete(job);
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    job.release();
    drain();
  });
  port.onMessage.addListener((message) => {
    if (message?.type === "ping") return;
    if (received) {
      send({ type: "error", message: "Only one local summary request is allowed per connection." });
      controller.abort();
      return;
    }
    received = true;
    const allowedProviders = summary.ALL_PROVIDERS || ["ollama", "lmstudio", "mlx", "splash", "copilot", "openai", "anthropic", "gemini"];
    if (!["models", "summarize", "briefing", "triage", "kev-status"].includes(message?.type) ||
        (message.type === "models" && message.provider !== undefined && !allowedProviders.includes(message.provider)) ||
        (message.type === "models" && message.apiKey !== undefined && (typeof message.apiKey !== "string" || message.apiKey.length > 500)) ||
        (["summarize", "briefing", "triage", "kev-status"].includes(message.type) && page !== "notifications")) {
      send({ type: "error", message: "Open AI settings or GitHub notifications to use local summaries." });
      return;
    }
    const target = message.type === "summarize" ? core.commentTarget(message.href) :
      message.type === "triage" ? (core.summaryTarget || core.commentTarget)(message.href) : null;
    if (["summarize", "triage"].includes(message.type) && !target) {
      send({ type: "error", message: "This notification has no supported exact comment link to summarize." });
      return;
    }
    if (message.type === "briefing" && (
      typeof message.model !== "string" || !message.model || message.model.length > 200 ||
      !Array.isArray(message.items) || !message.items.length || message.items.length > 30 ||
      (message.viewer !== undefined && (typeof message.viewer !== "string" || (message.viewer && !core.normalizeLogin(message.viewer))))
    )) {
      send({ type: "error", message: "The Today briefing request is invalid or has no P1 notification summaries." });
      return;
    }
    if (message.type === "triage" && (
      typeof message.text !== "string" || !message.text.trim() || message.text.length > 12000 ||
      (message.title !== undefined && (typeof message.title !== "string" || message.title.length > 500)) ||
      (message.author !== undefined && (typeof message.author !== "string" || message.author.length > 100)) ||
      (message.reason !== undefined && (typeof message.reason !== "string" || message.reason.length > 100)) ||
      (message.viewer !== undefined && (typeof message.viewer !== "string" || (message.viewer && !core.normalizeLogin(message.viewer))))
    )) {
      send({ type: "error", message: "The triage request is invalid or too large." });
      return;
    }
    if (message.type === "summarize" && (
      typeof message.text !== "string" || !message.text.trim() || message.text.length > 12000 ||
      typeof message.title !== "string" || message.title.length > 500 ||
      typeof message.author !== "string" || message.author.length > 100 ||
      typeof message.model !== "string" || message.model.length > 200 ||
      typeof message.truncated !== "boolean" ||
      (message.viewer !== undefined && (typeof message.viewer !== "string" || (message.viewer && !core.normalizeLogin(message.viewer)))) ||
      (message.dateTime !== undefined && (typeof message.dateTime !== "string" || (message.dateTime && !Number.isFinite(Date.parse(message.dateTime))))) ||
      (message.activity !== undefined && (typeof message.activity !== "string" || message.activity.length > 1600)) ||
      (message.tokens !== undefined && (typeof message.tokens !== "number" || !Number.isFinite(message.tokens) || message.tokens <= 0)) ||
      (message.contextWindow !== undefined && (typeof message.contextWindow !== "number" || !Number.isFinite(message.contextWindow) || message.contextWindow < 1024)) ||
      (message.priority !== undefined && (typeof message.priority !== "number" || !Number.isFinite(message.priority)))
    )) {
      send({ type: "error", message: "The comment summary request is invalid or too large. Refresh the inbox and retry." });
      return;
    }
    if (jobs.size >= MAX_QUEUED_JOBS) {
      send({ type: "error", message: "Too many local summaries are waiting. Stop another tab's summaries, then retry." });
      return;
    }
    job.key = target?.key || "";
    if (message.type === "summarize") {
      job.model = message.model;
      job.source = message;
      job.priority = typeof message.priority === "number" && Number.isFinite(message.priority) ? message.priority : 0;
      job.tokens = summary.estimateTokens ? summary.estimateTokens(message) : 2000;
      job.contextWindow = message.contextWindow || knownContextWindows.get(message.model) ||
        (summary.contextWindowForModel ? summary.contextWindowForModel(message.model) : 131072);
    }
    job.run = async () => {
      try {
        controller.signal.throwIfAborted();
        const activeProvider = message.type === "models" ? (message.provider || "ollama") :
          (message.type === "summarize" || message.type === "briefing") && summary.providerForModel ?
            summary.providerForModel(message.model) : "ollama";
        const requiredOrigin = summary.permissionOriginForProvider ?
          summary.permissionOriginForProvider(activeProvider) : summary.PERMISSION_ORIGIN;
        const permitted = await chrome.permissions.contains({ origins: [requiredOrigin] });
        if (!permitted) {
          throw new Error(requiredOrigin === summary.PERMISSION_ORIGIN ?
            "Allow this extension to access 127.0.0.1 in Chrome's extension settings, then retry." :
            `Allow this extension to access ${requiredOrigin} in AI settings, then retry.`);
        }
        controller.signal.throwIfAborted();
        const credentials = store.getProviderCredentials ? await store.getProviderCredentials() : {};
        const apiKey = (message.type === "models" && typeof message.apiKey === "string" && message.apiKey.trim()) ?
          message.apiKey.trim() : (credentials[activeProvider] || "");
        let value;
        if (message.type === "models") {
          value = await summary.listModels({ signal: controller.signal, provider: message.provider, apiKey });
          if (Array.isArray(value)) {
            for (const entry of value) {
              if (entry?.id && entry?.contextWindow) knownContextWindows.set(entry.id, entry.contextWindow);
            }
          }
        } else if (message.type === "kev-status") {
          try {
            const res = await fetch(`${summary.KEV_ORIGIN || "http://127.0.0.1:8009"}/v1/models`, {
              method: "GET",
              credentials: "omit",
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1200)])
            });
            value = Boolean(res && res.ok);
          } catch {
            value = false;
          }
        } else if (message.type === "triage") {
          value = summary.triageWithKev ? await summary.triageWithKev(message, { signal: controller.signal }) : null;
        } else if (message.type === "briefing") {
          const settings = await store.getSummarySettings();
          controller.signal.throwIfAborted();
          const expectedBriefingModel = settings.briefingModel || settings.model;
          if (!expectedBriefingModel || (message.model !== expectedBriefingModel && message.model !== settings.model)) {
            throw new Error("The local model setting changed. Open AI settings or retry the briefing.");
          }
          value = await summary.summarizeBriefing(message, {
            signal: controller.signal,
            apiKey,
            onProgress: (text) => send({ type: "progress", message: text })
          });
        } else {
          const [settings, subscriptions] = await Promise.all([store.getSummarySettings(), store.list()]);
          controller.signal.throwIfAborted();
          if (!settings.model || message.model !== settings.model) {
            throw new Error("The local model setting changed. Open AI settings or retry the summary.");
          }
          const wasSubscribed = subscriptions.some((item) => item.key === target.key);
          const viewer = core.normalizeLogin(message.viewer);
          const source = {
            model: settings.model, viewer, href: `${target.url}#${target.id}`,
            title: message.title, author: message.author, text: message.text,
            truncated: message.truncated, dateTime: message.dateTime || ""
          };
          const activity = message.activity || "";
          if (activity && (storeApi.validateActivity(activity, target.key)[2] || "thread") !== target.id) {
            throw new Error("The notification changed while loading. Refresh the inbox.");
          }
          const fingerprint = viewer ? await storeApi.sourceFingerprint(source) : "";
          const cached = viewer ? await store.getCachedSummary(viewer, { href: source.href }, settings.model, false) : null;
          controller.signal.throwIfAborted();
          if (cached && cached.fingerprint !== fingerprint) {
            await writeState(() => store.deleteCachedSummary(viewer, source.href));
          }
          const reused = cached?.fingerprint === fingerprint;
          const result = reused ? cached.result : await summary.summarize(source, {
            signal: controller.signal, apiKey, onProgress: (text) => send({ type: "progress", message: text })
          });
          controller.signal.throwIfAborted();
          const now = Date.now();
          const record = {
            viewer, href: source.href, model: settings.model, summaryVersion: summary.SUMMARY_VERSION,
            fingerprint, activity, result, author: source.author, dateTime: source.dateTime,
            truncated: source.truncated, generatedAt: reused ? cached.generatedAt : now, checkedAt: now
          };
          if (viewer) {
            await writeState(async () => {
              controller.signal.throwIfAborted();
              if ((wasSubscribed && !(await store.list()).some((entry) => entry.key === target.key)) ||
                  (await store.getSummarySettings()).model !== settings.model) {
                throw new Error("The subscription or model changed. Request a summary again with your current settings.");
              }
              controller.signal.throwIfAborted();
              await store.saveCachedSummary(record);
              // A removal or cancellation can arrive while Chrome is saving.
              if (controller.signal.aborted ||
                  (wasSubscribed && !(await store.list()).some((entry) => entry.key === target.key)) ||
                  (await store.getSummarySettings()).model !== settings.model) {
                await store.deleteCachedSummary(viewer, source.href);
                throw new Error("The summary was cancelled or its subscription was removed.");
              }
            });
          }
          value = { ...record, reused, persisted: !!viewer };
        }
        controller.signal.throwIfAborted();
        send({ type: "result", value });
      } catch (error) {
        if (!closed) send({ type: "error", message: core.cleanText(error.message, 600) || "The local summary failed. Check Ollama, then retry." });
      } finally {
        jobs.delete(job);
      }
    };
    jobs.add(job);
    if (["models", "triage", "kev-status"].includes(message.type)) void job.run();
    else {
      send({ type: "progress", message: activeJobs > 0 ? "Summarizing in parallel..." : "Starting local summary..." });
      queue.push(job);
      scheduleDrain();
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const job of jobs) {
    if (storeApi.isSummaryChange(changes, area) ||
        (job.key && Object.hasOwn(changes, core.STORAGE_PREFIX + job.key) &&
          !changes[core.STORAGE_PREFIX + job.key].newValue)) {
      const error = new Error("Summary settings or subscriptions changed. Retry with the current list.");
      job.send({ type: "error", message: error.message });
      job.controller.abort(error);
    }
  }
});
