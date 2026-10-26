(function startGitHubSubscriptions() {
  "use strict";

  const core = globalThis.GitHubSubscriptions;
  const dom = globalThis.GitHubSubscriptionDom;
  const preview = globalThis.GitHubSubscriptionPreview;
  const summaryApi = globalThis.GitHubSubscriptionSummary;
  const summaryClient = globalThis.GitHubSubscriptionSummaryClient;
  const scanner = globalThis.GitHubSubscriptionScanner;
  const storeApi = globalThis.GitHubSubscriptionStore;
  const store = storeApi.createStore(chrome.storage.local);
  const INBOX = `${core.ORIGIN}/notifications`;
  const SIDEBAR_SELECTOR = "aside, .Layout-sidebar, .notifications-sidebar, .SideNav, [aria-label='Notifications']";
  const hiddenNative = new Map();
  const nativeSelection = new Map();
  let subscriptions = new Map();
  let filter = { ...core.DEFAULT_FILTER };
  let priorityRules = { ...core.DEFAULT_PRIORITY_RULES };
  let summarySettings = { ...summaryApi.DEFAULT_SETTINGS };
  let summarySettingsError = "";
  let summaryVersion = 0;
  let ready = false;
  let storageError = "";
  let loadVersion = 0;
  let view = null;
  let nativeView = null;
  const SCAN_CACHE_PREFIX = "scan-cache:v1:";
  const TODAY_BRIEFING_PREFIX = "today-briefing:v1:";
  const SCAN_CACHE_MS = 10 * 60 * 1000;
  const PRIORITY_CACHE_MS = 4 * 60 * 60 * 1000;
  const memorySummaries = new Map();
  const memoryBriefings = new Map();
  const checkedInThisTab = new Set();
  let scheduled = false;

  function memorySummaryKey(viewer, model, itemKey) {
    return viewer && model && itemKey ? `${viewer}|${model}|${itemKey}` : "";
  }

  function tabCheckKey(viewer, model, itemKey, activity) {
    return `${viewer || "anon"}|${model || ""}|${itemKey || ""}|${activity || ""}`;
  }

  function todayBriefingStorageKey(viewer) {
    return `${TODAY_BRIEFING_PREFIX}${viewer || "default"}`;
  }

  async function preloadMemorySummaries() {
    try {
      const all = await chrome.storage.local.get(null);
      const prefix = storeApi.CACHE_PREFIX;
      for (const [storageKey, record] of Object.entries(all)) {
        if (!storageKey.startsWith(prefix) || !record?.viewer || !record?.model || !record?.href) continue;
        const itemKey = (core.summaryTarget || core.commentTarget)(record.href)?.key;
        const memKey = memorySummaryKey(record.viewer, record.model, itemKey);
        if (memKey && !memorySummaries.has(memKey)) {
          memorySummaries.set(memKey, record);
        }
      }
    } catch {
      // Best-effort preload into RAM.
    }
  }

  function sameLocalDay(first, second) {
    const a = new Date(first);
    const b = new Date(second);
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function isFreshScanCache(current, checkedAt, now = Date.now()) {
    const age = now - checkedAt;
    if (!Number.isFinite(age) || age < 0) return false;
    if (current?.mode === "priority" || current?.mode === "today") {
      return age < PRIORITY_CACHE_MS && sameLocalDay(checkedAt, now);
    }
    return age < SCAN_CACHE_MS;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function owned(node) {
    node.setAttribute("data-gns-owned", "");
    return node;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function bookmark() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M4 2.5h8v11l-4-2.6-4 2.6z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function priorityIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M9 1.75 3.5 9h4.25L7 14.25 12.5 7H8.25Z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function todayIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M8 4.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5ZM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M12.6 3.4l-1.06 1.06M4.46 11.54 3.4 12.6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    return svg;
  }

  async function restoreUnreadState(item) {
    if (!item?.unread || !item.notificationId) return;
    const token = item.unmarkToken ||
      document.querySelector("form[action='/notifications/beta/unmark'] input[name='authenticity_token']")?.value || "";
    if (!token) return;
    try {
      const body = new URLSearchParams();
      body.set("authenticity_token", token);
      body.append("notification_ids[]", item.notificationId);
      const response = await fetch(`${core.ORIGIN}/notifications/beta/unmark`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return;
      for (const row of document.querySelectorAll(dom.ROW_SELECTOR)) {
        const rowId = row.getAttribute("data-notification-id") ||
          row.querySelector("input[name='notification_ids[]']")?.value || "";
        if (rowId === item.notificationId) {
          row.classList.add("notification-unread");
          row.classList.remove("notification-read");
          row.setAttribute("data-unread", "true");
        }
      }
    } catch {
      // Best-effort unread restoration; never fail preview or summary generation.
    }
  }

  function computeItemPriority(current, item) {
    if (current?.prioritySnapshot?.has(item.key)) {
      return current.prioritySnapshot.get(item.key);
    }
    return core.scorePriority(item, {
      subscribed: subscriptions.has(item.key),
      author: current?.authors?.get(item.key) || "",
      summaryResponse: current?.responses?.get(item.key) || "",
      kev: current?.kevScores?.get(item.key) || null,
      rules: priorityRules
    });
  }

  function lockPrioritySnapshot(current) {
    if (!current || current.priorityOrder?.length) return;
    const entries = [...current.items.values()]
      .map((item) => ({
        item,
        priority: core.scorePriority(item, {
          subscribed: subscriptions.has(item.key),
          author: current.authors?.get(item.key) || "",
          summaryResponse: current.responses?.get(item.key) || "",
          kev: current.kevScores?.get(item.key) || null,
          rules: priorityRules
        })
      }))
      .filter(({ priority }) => priority.qualifies)
      .sort((left, right) => right.priority.score - left.priority.score ||
        (Date.parse(right.item.dateTime || "") || 0) - (Date.parse(left.item.dateTime || "") || 0));
    current.priorityOrder = entries.map(({ item }) => item.key);
    current.prioritySnapshot = new Map(entries.map(({ item, priority }) => [item.key, priority]));
  }

  function classifyItemSweep(current, item) {
    return core.classifySweep(item, {
      subscribed: subscriptions.has(item.key),
      author: current?.authors?.get(item.key) || "",
      summaryResponse: current?.responses?.get(item.key) || "",
      kev: current?.kevScores?.get(item.key) || null,
      rules: priorityRules
    });
  }

  async function resolveArchiveToken(items) {
    for (const item of items) {
      if (item.archiveToken) return item.archiveToken;
    }
    const domToken = document.querySelector("form[action='/notifications/beta/archive'] input[name='authenticity_token']")?.value;
    if (domToken) return domToken;
    try {
      const res = await fetch(INBOX, {
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok && res.headers.get("content-type")?.includes("text/html")) {
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        return doc.querySelector("form[action='/notifications/beta/archive'] input[name='authenticity_token']")?.value || "";
      }
    } catch {
      // Ignore fallback token fetch failure.
    }
    return "";
  }

  async function sweepNotifications(current, bucket) {
    if (!current || current.sweeping) return;
    const allItems = [...current.items.values()];
    const targets = allItems.filter((item) => {
      const info = classifyItemSweep(current, item);
      return info.sweepable && (bucket === "all" || info.bucket === bucket);
    });
    if (!targets.length) return;
    current.sweeping = true;
    current.sweepMessage = `Marking ${targets.length} ${targets.length === 1 ? "notification" : "notifications"} Read & Done...`;
    renderView(current);
    try {
      const token = await resolveArchiveToken(allItems);
      const ids = targets.map((item) => item.notificationId).filter(Boolean);
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
          const body = new URLSearchParams();
          if (token) body.set("authenticity_token", token);
          for (const id of batch) body.append("notification_ids[]", id);
          const response = await fetch(`${core.ORIGIN}/notifications/beta/archive`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-Requested-With": "XMLHttpRequest"
            },
            body: body.toString(),
            signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) {
            throw new Error(`GitHub could not mark notifications Done (HTTP ${response.status}).`);
          }
        }
      }
      for (const item of targets) {
        current.items.delete(item.key);
        current.scanned.delete(item.key);
        current.prioritySnapshot?.delete(item.key);
      }
      if (Array.isArray(current.priorityOrder)) {
        const sweptKeys = new Set(targets.map((item) => item.key));
        current.priorityOrder = current.priorityOrder.filter((key) => !sweptKeys.has(key));
      }
      saveScanCache(current);
      const label = bucket === "review-requested" ? "Review requested" :
        bucket === "team-mention" ? "Team mentioned" :
        bucket === "stale-participating" ? "Stale participating" : "noisy";
      current.sweepMessage = `Swept ${targets.length} ${label} ${targets.length === 1 ? "notification" : "notifications"} (Read & Done).`;
    } catch (error) {
      current.localError = errorText(error);
    } finally {
      current.sweeping = false;
      renderView(current);
    }
  }

  async function refinePriorityWithKev(current) {
    if (!current || (current.mode !== "priority" && current.mode !== "today") || current.kevRefining || current.kevOffline || current.kevDone) return;
    current.kevRefining = true;
    const signal = current.previewController.signal;
    try {
      const online = await summaryClient.request({ type: "kev-status" }, { signal });
      if (!online || view !== current) {
        current.kevOffline = true;
        current.kevDone = true;
        return;
      }
      const candidates = [...current.items.values()]
        .filter((item) => !current.kevScores.has(item.key) && !caughtUp(current, item))
        .sort((a, b) => computeItemPriority(current, b).score - computeItemPriority(current, a).score)
        .slice(0, 20);
      await Promise.all(candidates.map(async (item) => {
        if (signal.aborted || view !== current) return;
        const target = core.summaryTarget(item.href);
        if (!target) return;
        try {
          const loaded = await preview.load(target, { signal, allowFallback: true });
          if (!loaded || signal.aborted || view !== current) return;
          if (loaded.author) current.authors.set(item.key, loaded.author);
          const kevResult = await summaryClient.request({
            type: "triage",
            href: `${target.url}#${target.id}`,
            title: core.cleanText(item.title, 500),
            reason: item.reason || "",
            author: loaded.author,
            viewer: current.viewer,
            text: loaded.text
          }, { signal });
          if (kevResult && view === current) {
            current.kevScores.set(item.key, kevResult);
          }
        } catch {
          // Individual item triage failures do not block the Priority view.
        }
      }));
      if (view === current) {
        current.kevDone = true;
        saveScanCache(current);
      }
    } catch {
      current.kevOffline = true;
      current.kevDone = true;
    } finally {
      current.kevRefining = false;
    }
  }

  function errorText(error) {
    if (/Extension context invalidated/i.test(error?.message)) {
      return "The extension was reloaded. Refresh this GitHub tab.";
    }
    return core.cleanText(error?.message, 400) || "Subscriptions could not finish that action. Refresh this tab and try again.";
  }

  function signedInLogin() {
    return core.normalizeLogin(document.querySelector('meta[name="user-login"]')?.content);
  }

  function caughtUp(current, item) {
    const activity = storeApi.activityToken(item);
    return !!activity && current.reviews.get(item.key)?.activity === activity;
  }

  async function localAction(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "Local state could not be saved. Refresh this tab and retry.");
    return result.value;
  }

  async function loadReviews(current) {
    const version = ++current.reviewVersion;
    try {
      const reviews = current.viewer ? await store.listReviews(current.viewer) : new Map();
      if ((view !== current && nativeView !== current) || version !== current.reviewVersion) return;
      current.reviews = reviews;
      current.reviewsReady = true;
      current.localError = "";
      if (view === current) renderView(current);
      else renderSummaryControls(current);
      for (const tools of current.commentTools.values()) tools.reviewChanged();
    } catch (error) {
      if ((view !== current && nativeView !== current) || version !== current.reviewVersion) return;
      current.reviewsReady = false;
      current.localError = errorText(error);
      if (view === current) renderView(current);
      else renderSummaryControls(current);
    }
  }

  async function changeCaughtUp(current, item, reviewed) {
    try {
      await localAction({ type: "gns:set-caught-up", viewer: current.viewer, item, caughtUp: reviewed });
      if (view !== current) return;
      current.undoItem = reviewed ? item : null;
      await loadReviews(current);
      if (reviewed && !current.showCaughtUp) current.undo.focus({ preventScroll: true });
    } catch (error) {
      if (view !== current) return;
      current.localError = errorText(error);
      renderView(current);
    }
  }

  function report(error) {
    const message = errorText(error);
    if (view) {
      view.error = message;
      renderView(view);
      return;
    }
    let notice = document.querySelector("[data-gns-notice]");
    if (!notice) {
      notice = owned(element("p", "gns-notice"));
      notice.setAttribute("data-gns-notice", "");
      notice.setAttribute("role", "alert");
      (document.querySelector("main") || document.body).prepend(notice);
    }
    setText(notice, message);
  }

  function button(label, className, action) {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await action(node);
      } catch (error) {
        report(error);
      }
    });
    return node;
  }

  async function openManager() {
    const result = await chrome.runtime.sendMessage({ type: "gns:open-manager" });
    if (!result?.ok) throw new Error(result?.error || "The subscription manager could not be opened. Use the extension's toolbar icon.");
  }

  async function openSummarySettings() {
    const result = await chrome.runtime.sendMessage({ type: "gns:open-summary-settings" });
    if (!result?.ok) throw new Error(result?.error || "AI settings could not be opened. Use the extension's toolbar icon.");
  }

  async function loadSummarySettings() {
    const version = ++summaryVersion;
    try {
      const saved = await store.getSummarySettings();
      if (version !== summaryVersion) return;
      const modelChanged = saved.model !== summarySettings.model;
      const stoppedAutomatic = summarySettings.automatic && !saved.automatic;
      summarySettings = saved;
      summarySettingsError = "";
      if (modelChanged) {
        memorySummaries.clear();
        checkedInThisTab.clear();
      }
      for (const current of [view, nativeView]) {
        if (!current) continue;
        current.modelCheckPromise = null;
        current.modelCheckModel = "";
        current.contextWindow = summaryApi.contextWindowForModel(saved.model);
        if (modelChanged || stoppedAutomatic) stopSummaries(current);
        if (modelChanged || saved.automatic) current.summariesPaused = false;
        for (const tools of current.commentTools.values()) tools.settingsChanged(modelChanged);
        renderSummaryControls(current);
      }
    } catch (error) {
      if (version !== summaryVersion) return;
      summarySettingsError = errorText(error);
      for (const current of [view, nativeView]) {
        if (!current) continue;
        stopSummaries(current);
        renderSummaryControls(current);
      }
    }
  }

  let localFilePriorityRules = null;
  async function loadDefaultPriorityRules() {
    if (localFilePriorityRules) return localFilePriorityRules;
    try {
      const response = await chrome.runtime.sendMessage({ type: "gns:get-local-priority-rules" });
      if (response?.ok && response.value) {
        localFilePriorityRules = core.validatePriorityRules(response.value);
        return localFilePriorityRules;
      }
    } catch {
      // Fall back to empty rules when service worker or local file is unavailable.
    }
    localFilePriorityRules = core.DEFAULT_PRIORITY_RULES;
    return localFilePriorityRules;
  }

  async function loadSubscriptions() {
    const version = ++loadVersion;
    try {
      const [items, savedFilter, savedRules] = await Promise.all([
        store.list(),
        store.getFilter(),
        store.getPriorityRules ? store.getPriorityRules() : Promise.resolve(core.DEFAULT_PRIORITY_RULES)
      ]);
      if (version !== loadVersion) return;
      subscriptions = new Map(items.map((item) => [item.key, item]));
      filter = savedFilter;
      const hasStoredRules = Object.keys(savedRules.contacts || {}).length > 0 ||
        (savedRules.coreRepos?.length || 0) > 0 || (savedRules.adjacentRepos?.length || 0) > 0;
      priorityRules = hasStoredRules ? savedRules : await loadDefaultPriorityRules();
      storageError = "";
      ready = true;
      reconcile();
    } catch (error) {
      if (version !== loadVersion) return;
      ready = false;
      storageError = errorText(error);
      if (view) view.controller?.abort();
      reconcile();
      report(error);
    }
  }

  function updatePin(node, item, compact) {
    if (!node) return;
    const saved = subscriptions.has(item.key);
    const label = saved ? "Remove from subscriptions" : "Add to subscriptions";
    node.dataset.saved = String(saved);
    node.setAttribute("aria-pressed", String(saved));
    node.setAttribute("aria-label", `${label}: ${item.label}`);
    node.title = `${label} (extension only)`;
    node.disabled = !ready;
    if (!compact) setText(node.querySelector("span"), saved ? "In subscriptions" : "Add to subscriptions");
  }

  function createPin(item, compact = true) {
    const node = owned(button("", compact ? "gns-pin" : "gns-button gns-item-pin", async (clicked) => {
      if (!ready || clicked.dataset.pending === "true") return;
      clicked.dataset.pending = "true";
      const wasSaved = subscriptions.has(item.key);
      if (wasSaved) subscriptions.delete(item.key);
      else subscriptions.set(item.key, { ...item, savedAt: Date.now() });
      updatePin(clicked, item, compact);
      try {
        if (wasSaved) await store.remove(item);
        else await store.add([item]);
        await loadSubscriptions();
      } catch (error) {
        if (wasSaved) subscriptions.set(item.key, { ...item, savedAt: Date.now() });
        else subscriptions.delete(item.key);
        throw error;
      } finally {
        delete clicked.dataset.pending;
        updatePin(clicked, item, compact);
      }
    }));
    node.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    node.dataset.gnsPin = item.key;
    node.dataset.itemUrl = item.url;
    node.append(bookmark());
    if (!compact) node.append(element("span"));
    updatePin(node, item, compact);
    return node;
  }

  function decorateRows(current = nativeView) {
    if (current) {
      for (const [key, entry] of current.rowEntries) {
        if (!entry.row.isConnected) {
          entry.tools.cancel();
          current.commentTools.delete(key);
          current.rowEntries.delete(key);
        }
      }
    }
    for (const row of document.querySelectorAll(dom.ROW_SELECTOR)) {
      const item = dom.readRow(row);
      const existingInline = row.querySelector("[data-gns-row-inline]");
      const existingActivity = row.querySelector("[data-gns-row-activity]");
      const existingDetails = row.querySelector("[data-gns-row-details]");
      const existingPin = row.querySelector("[data-gns-pin]");
      if (!item) {
        existingInline?.remove();
        existingActivity?.remove();
        existingDetails?.remove();
        existingPin?.remove();
        delete row.dataset.gnsRowExpanded;
        delete row.dataset.gnsHasSummary;
        continue;
      }
      if (!current) {
        if (existingPin && existingPin.dataset.gnsPin !== item.key) existingPin.remove();
        if (existingPin?.isConnected) updatePin(existingPin, item, true);
        else {
          const link = row.querySelector("a.notification-list-item-link, a[data-testid='notification-link']");
          const pin = createPin(item);
          if (link) link.after(pin);
          else row.append(pin);
        }
        continue;
      }
      const rowId = row.getAttribute("data-notification-id") || item.href || item.key;
      const entryKey = `${item.key}|${rowId}`;
      const activity = storeApi.activityToken(item);
      if (existingInline?.isConnected && existingInline.dataset.gnsRowInline === entryKey &&
          existingInline.dataset.activity === activity && current.rowEntries.has(entryKey)) {
        updatePin(existingInline.querySelector("[data-gns-pin]"), item, true);
        continue;
      }
      if (current.rowEntries.has(entryKey)) {
        current.rowEntries.get(entryKey).tools.cancel();
        current.commentTools.delete(entryKey);
        current.rowEntries.delete(entryKey);
      }
      existingInline?.remove();
      existingActivity?.remove();
      existingDetails?.remove();
      existingPin?.remove();
      delete row.dataset.gnsRowExpanded;
      delete row.dataset.gnsHasSummary;

      const tools = commentTools(item, current);
      current.commentTools.set(entryKey, tools);
      const activityCol = owned(element("div", "gns-native-activity"));
      activityCol.dataset.gnsRowActivity = entryKey;

      const inline = owned(element("div", "gns-native-inline"));
      inline.dataset.gnsRowInline = entryKey;
      inline.dataset.activity = activity;

      const drawer = owned(element("div", "gns-result-details gns-native-details"));
      drawer.id = `gns-details-${++detailsId}`;
      drawer.hidden = true;
      drawer.dataset.gnsRowDetails = entryKey;

      const hasTarget = !!core.summaryTarget(item.href);
      const more = button("", "gns-icon-button gns-more", () => {
        drawer.hidden = !drawer.hidden;
        more.setAttribute("aria-expanded", String(!drawer.hidden));
        row.dataset.gnsRowExpanded = String(!drawer.hidden);
      });
      more.append(icon("M3 8a1.25 1.25 0 1 0 0 .01M8 8a1.25 1.25 0 1 0 0 .01M13 8a1.25 1.25 0 1 0 0 .01", true));
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", drawer.id);
      more.setAttribute("aria-label", `More details: ${item.label}`);
      more.title = "Comment preview and summary details";
      more.hidden = !hasTarget;

      const pin = createPin(item, true);
      tools.onStateChange((phase) => {
        const visibleActivity = hasTarget && !!summarySettings.model;
        activityCol.hidden = !visibleActivity;
        activityCol.dataset.state = phase;
        row.dataset.gnsHasSummary = String(visibleActivity && ["queued", "running", "done", "error"].includes(phase));
      });
      activityCol.append(tools.summary);
      inline.append(more, pin);
      drawer.append(tools.summaryDetails, tools.preview);

      const nestedRow = row.querySelector(":scope > .d-flex");
      const link = row.querySelector("a.notification-list-item-link, a[data-testid='notification-link']");
      if (nestedRow) {
        row.dataset.gnsNestedRow = "true";
        nestedRow.classList.add("gns-native-row-grid");
        const leftCol = nestedRow.firstElementChild;
        const rightCol = nestedRow.lastElementChild !== leftCol ? nestedRow.lastElementChild : null;
        if (leftCol) leftCol.after(activityCol);
        else nestedRow.append(activityCol);
        if (rightCol) rightCol.append(inline);
        else nestedRow.append(inline);
      } else {
        if (link) link.after(activityCol);
        else row.append(activityCol);
        row.append(inline);
      }
      row.append(drawer);

      current.rowEntries.set(entryKey, { row, item, tools, inline, activityCol, drawer });
      tools.settingsChanged(false);
    }
  }

  function decorateItemPage() {
    const item = core.parseItem(location.href);
    let tools = document.querySelector("[data-gns-item-tools]");
    if (tools && tools.dataset.gnsItemTools !== item?.key) {
      tools.remove();
      tools = null;
    }
    if (!item) return;
    if (tools) {
      updatePin(tools.querySelector("[data-gns-pin]"), item, false);
      return;
    }
    const main = document.querySelector("main, [role='main']");
    if (!main) return;
    const header = main.querySelector("#partial-discussion-header, .gh-header, [data-testid='issue-header']");
    tools = owned(element("div", "gns-item-tools"));
    tools.dataset.gnsItemTools = item.key;
    tools.append(
      createPin(item, false),
      button("Manage list", "gns-text-button", openManager)
    );
    if (header) header.append(tools);
    else main.prepend(tools);
  }

  function ensureSidebar(activeMode) {
    const active = !!activeMode;
    let lists = dom.filterLists(document);
    if (!lists.length) {
      let fallback = document.querySelector("[data-gns-filter-list]");
      if (!fallback) {
        const inboxLink = [...document.querySelectorAll("a[href]")].find((candidate) => {
          if (candidate.closest("[data-gns-owned], header, [aria-label='Breadcrumbs'], .AppHeader")) return false;
          const url = core.githubUrl(candidate.getAttribute("href"));
          return candidate.closest(SIDEBAR_SELECTOR) && url?.pathname === "/notifications" && !url.search && !url.hash &&
            /^Inbox\b/i.test(core.cleanText(candidate.textContent));
        });
        const sidebar = inboxLink?.closest(SIDEBAR_SELECTOR);
        if (sidebar) {
          const group = owned(element("section", "gns-filter-group"));
          const heading = element("h2", "gns-filter-heading", "Filters");
          fallback = element("ul");
          fallback.dataset.gnsFilterList = "";
          fallback.setAttribute("aria-label", "Filters");
          group.append(heading, fallback);
          sidebar.append(group);
        }
      }
      if (fallback) lists = [fallback];
    } else {
      document.querySelector(".gns-filter-group")?.remove();
    }
    for (const link of document.querySelectorAll("[data-gns-filter], [data-gns-priority-filter], [data-gns-today-filter]")) {
      if (!filter.enabled || !lists.some((list) => list.contains(link))) {
        (link.closest(".gns-sidebar-item") || link).remove();
      }
    }
    const hasPriorityCache = (view?.mode === "priority" || view?.mode === "today") && view.cacheLoaded;
    const priorityCount = hasPriorityCache ?
      String([...view.items.values()].filter((item) => computeItemPriority(view, item).qualifies).length) : "★";
    const todayCount = hasPriorityCache ?
      String([...view.items.values()].filter((item) => {
        const p = computeItemPriority(view, item);
        return p.qualifies && p.tier === "P1";
      }).length) : "P1";
    let activeSubCount = null;
    if (view?.cacheLoaded) {
      const subMatches = [...view.items.values()].filter((item) => subscriptions.has(item.key));
      const subVisible = view.showCaughtUp ? subMatches : subMatches.filter((item) => !caughtUp(view, item));
      activeSubCount = subVisible.length;
    }
    for (const list of filter.enabled ? lists : []) {
      let todayLink = list.querySelector("[data-gns-today-filter]");
      if (!todayLink) {
        todayLink = owned(element("a", "gns-sidebar-link"));
        todayLink.href = INBOX + core.TODAY_HASH;
        todayLink.dataset.gnsTodayFilter = "";
        todayLink.setAttribute("data-turbo", "false");
        todayLink.title = "Today: Morning executive briefing for P1 notifications (Experimental)";
        todayLink.append(todayIcon(), element("span", "gns-today-filter-name", "Today"), element("span", "gns-count"));
        const todayLi = owned(element("li", "gns-sidebar-item"));
        todayLi.append(todayLink);
        list.prepend(todayLi);
      }
      setText(todayLink.querySelector(".gns-count"), todayCount);
      todayLink.querySelector(".gns-count").title = "P1 notifications for Today's briefing";
      if (activeMode === "today") todayLink.setAttribute("aria-current", "page");
      else todayLink.removeAttribute("aria-current");

      let priorityLink = list.querySelector("[data-gns-priority-filter]");
      if (!priorityLink) {
        priorityLink = owned(element("a", "gns-sidebar-link"));
        priorityLink.href = INBOX + core.PRIORITY_HASH;
        priorityLink.dataset.gnsPriorityFilter = "";
        priorityLink.setAttribute("data-turbo", "false");
        priorityLink.title = "Priority notifications (recency + direct asks + org hierarchy)";
        priorityLink.append(priorityIcon(), element("span", "gns-priority-filter-name", "Priority"), element("span", "gns-count"));
        const priorityLi = owned(element("li", "gns-sidebar-item"));
        priorityLi.append(priorityLink);
        list.prepend(priorityLi);
      }
      setText(priorityLink.querySelector(".gns-count"), priorityCount);
      priorityLink.querySelector(".gns-count").title = "High-priority notifications";
      if (activeMode === "priority") priorityLink.setAttribute("aria-current", "page");
      else priorityLink.removeAttribute("aria-current");

      let link = list.querySelector("[data-gns-filter]");
      if (!link) {
        link = owned(element("a", "gns-sidebar-link"));
        link.href = INBOX + core.FILTER_HASH;
        link.dataset.gnsFilter = "";
        link.setAttribute("data-turbo", "false");
        link.title = "Subscription list filter (this Chrome profile only)";
        link.append(bookmark(), element("span", "gns-filter-name"), element("span", "gns-count"));
        const li = owned(element("li", "gns-sidebar-item"));
        li.append(link);
        list.prepend(li);
      }
      setText(link.querySelector(".gns-filter-name"), filter.name);
      setText(link.querySelector(".gns-count"), !ready ? "..." : activeSubCount !== null ? String(activeSubCount) : String(subscriptions.size));
      link.querySelector(".gns-count").title = activeSubCount !== null ?
        `${activeSubCount} active inbox notifications (${subscriptions.size} saved in subscription list)` :
        `${subscriptions.size} items in your subscription list`;
      if (activeMode === "subscriptions") link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");

      const todayItem = todayLink.closest(".gns-sidebar-item");
      const priorityItem = priorityLink.closest(".gns-sidebar-item");
      const subItem = link.closest(".gns-sidebar-item");
      if (todayItem && priorityItem && subItem &&
          (list.children[0] !== todayItem || list.children[1] !== priorityItem || list.children[2] !== subItem)) {
        list.prepend(todayItem, priorityItem, subItem);
      }

      if (active) {
        const navigation = link.closest(SIDEBAR_SELECTOR) || list;
        for (const selected of navigation.querySelectorAll("[aria-current='page'], .selected, .ActionListItem--navActive")) {
          if (selected.closest("[data-gns-owned]") || nativeSelection.has(selected)) continue;
          const classes = ["selected", "ActionListItem--navActive"].filter((name) => selected.classList.contains(name));
          nativeSelection.set(selected, {
            current: selected.getAttribute("aria-current"),
            classes,
            location: location.pathname + location.search
          });
          selected.removeAttribute("aria-current");
          selected.classList.remove(...classes);
        }
      }
    }
    if (!active) restoreSelection();
  }

  function filterMessage(form, message, failed = false) {
    const note = form.querySelector("[data-gns-filter-option] .gns-filter-message");
    if (note) {
      setText(note, message);
      note.dataset.failed = String(failed);
      note.setAttribute("role", failed ? "alert" : "status");
    }
  }

  function decorateFilterForms() {
    for (const form of document.querySelectorAll("form")) {
      const fields = dom.filterForm(form);
      if (!fields || form.querySelector("[data-gns-filter-option]")) continue;
      const option = owned(element("div", "gns-filter-option"));
      option.dataset.gnsFilterOption = "";
      form.dataset.gnsCreateForm = "";
      const use = button("Use subscription list", "gns-button", () => {
        if (!fields.name.value.trim()) fields.name.value = filter.name;
        fields.query.value = core.FILTER_QUERY;
        for (const input of [fields.name, fields.query]) {
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        filterMessage(form, "Choose Create to save this local filter. It uses your existing subscription list.");
        fields.name.focus();
      });
      const note = element("p", "gns-filter-message",
        "Extension option: filter by your saved items. The filter stays in this Chrome profile, not your GitHub account.");
      note.setAttribute("role", "status");
      option.append(use, note);
      form.append(option);
    }

    const dialogs = new Set([...document.querySelectorAll("input[name='custom_inbox[name]'], input[aria-label='Inbox name']")]
      .map((input) => input.closest("dialog, [role='dialog'], details-dialog")).filter(Boolean));
    for (const dialog of dialogs) {
      let settings = dialog.querySelector("[data-gns-filter-settings]");
      if (!settings) {
        settings = owned(element("section", "gns-filter-settings"));
        settings.dataset.gnsFilterSettings = "";
        settings.setAttribute("aria-label", "Local subscription filter");
        const heading = element("h4", "", "Subscription list filter");
        const label = element("label", "gns-filter-label", "Local filter name");
        const name = element("input", "gns-filter-input");
        name.type = "text";
        name.maxLength = 40;
        name.value = filter.name;
        name.dataset.gnsSavedName = filter.name;
        name.setAttribute("aria-label", "Local filter name");
        label.append(name);
        const actions = element("div", "gns-actions");
        const status = element("p", "gns-filter-message");
        status.setAttribute("role", "status");
        async function save(enabled) {
          try {
            await store.saveFilter({ name: name.value, enabled });
            await loadSubscriptions();
            if (!ready) throw new Error(storageError);
            setText(status, enabled ? "Local filter saved." : "Filter hidden. Your subscription list is unchanged.");
            status.dataset.failed = "false";
            status.setAttribute("role", "status");
          } catch (error) {
            status.dataset.failed = "true";
            status.setAttribute("role", "alert");
            setText(status, errorText(error));
          }
        }
        const saveButton = button("Save local filter", "gns-button", () => save(true));
        const hide = button("Hide filter", "gns-text-button", () => save(false));
        hide.dataset.gnsHideFilter = "";
        actions.append(saveButton, hide);
        settings.append(heading, label, actions,
          element("p", "gns-filter-message", "One filter for your subscription list. Saved only in this Chrome profile."), status);
        dialog.append(settings);
      }
      const name = settings.querySelector("input");
      if (name.value === name.dataset.gnsSavedName) name.value = filter.name;
      name.dataset.gnsSavedName = filter.name;
      settings.querySelector("[data-gns-hide-filter]").disabled = !filter.enabled;
    }
  }

  async function saveFilterForm(form, fields) {
    if (form.dataset.gnsSaving === "true") return;
    if (!core.isSubscriptionQuery(fields.query.value)) {
      filterMessage(form, `Use ${core.FILTER_QUERY} on its own. Other searches remain ordinary GitHub filters.`, true);
      return;
    }
    if (!form.reportValidity()) return;
    form.dataset.gnsSaving = "true";
    filterMessage(form, "Saving local filter...");
    try {
      await store.saveFilter({ name: fields.name.value, enabled: true });
      await loadSubscriptions();
      if (!ready) throw new Error(storageError);
      const dialog = form.closest("dialog, [role='dialog'], details-dialog");
      if (typeof dialog?.close === "function") dialog.close();
      else dialog?.querySelector("[aria-label='Close dialog']")?.click();
      location.assign(INBOX + core.FILTER_HASH);
    } catch (error) {
      filterMessage(form, errorText(error), true);
    } finally {
      delete form.dataset.gnsSaving;
    }
  }

  function interceptFilterSubmit(event) {
    if (!core.isNotifications(location.href)) return;
    const submitter = event.type === "click" ? event.target.closest?.("button, input[type='submit']") : null;
    if (event.type === "click" && submitter?.type !== "submit") return;
    const form = event.type === "submit" ? event.target : submitter?.form;
    const fields = dom.filterForm(form);
    if (!fields || !/(?:^|\s)subscriptions:/i.test(fields.query.value)) return;
    // Only the extension's explicit query is local. Every ordinary GitHub
    // create/update/delete action keeps its native handling.
    event.preventDefault();
    event.stopImmediatePropagation();
    void saveFilterForm(form, fields);
  }

  function restoreSelection() {
    for (const [node, original] of nativeSelection) {
      if (!node.isConnected || original.location !== location.pathname + location.search) continue;
      if (original.current !== null) node.setAttribute("aria-current", original.current);
      node.classList.add(...original.classes);
    }
    nativeSelection.clear();
  }

  function hideNative(root) {
    const targets = new Set([
      root,
      ...document.querySelectorAll(
        ".js-notifications-list-paginator, .paginate-container, .pagination, " +
        ".js-notifications-mark-all, .js-notifications-mark-selected-actions"
      ),
      ...[...document.querySelectorAll(dom.ROW_SELECTOR)].map((row) =>
        row.closest(".Box") || row.closest(".js-notifications-group") || row)
    ]);
    for (const target of targets) {
      if (!target || target.closest("[data-gns-owned]") || hiddenNative.has(target)) continue;
      hiddenNative.set(target, target.inert);
      target.setAttribute("data-gns-native-hidden", "");
      target.inert = true;
    }
  }

  function restoreNative() {
    for (const [node, inert] of hiddenNative) {
      node.removeAttribute("data-gns-native-hidden");
      node.inert = inert;
    }
    hiddenNative.clear();
  }

  function makeView(root, mode = "subscriptions") {
    const panel = owned(element("section", "gns-panel"));
    panel.dataset.gnsPanel = mode;
    panel.setAttribute("aria-label", mode === "today" ? "Today morning briefing" :
      mode === "priority" ? "Priority notifications" : "Subscribed notifications");
    const header = element("div", "gns-panel-header");
    const heading = element("div", "gns-heading-group");
    const title = element("h2", "gns-heading", mode === "today" ? "Today" : mode === "priority" ? "Priority" : filter.name);
    const count = element("span", "gns-counter", "");
    const live = element("span", "gns-live");
    live.setAttribute("aria-hidden", "true");
    heading.append(title, count, live);
    const actions = element("div", "gns-actions gns-header-actions");

    const status = element("p", "gns-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const pause = button("Pause", "gns-text-button", () => {
      if (!view) return;
      if (view.state.running && !view.paused) {
        view.paused = true;
        view.controller.abort();
        renderView(view);
      } else return runView(view);
    });
    const refresh = button("", "gns-icon-button gns-refresh", () => {
      const currentMode = view?.mode || (core.isTodayView?.(location.href) ? "today" :
        core.isPriorityView(location.href) ? "priority" : "subscriptions");
      stopView();
      ensureView(true, currentMode);
    });
    refresh.append(icon("M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v2.75H10.5"));
    refresh.setAttribute("aria-label", "Refresh");
    refresh.title = "Refresh: search the inbox again";
    const summaryNote = element("p", "gns-summary-note");
    summaryNote.setAttribute("role", "status");
    const summarize = button("Summarize comments", "gns-button", () => {
      if (!view) return;
      view.summariesPaused = false;
      for (const tools of [...view.commentTools.values()].sort((left, right) => right.priority() - left.priority())) {
        if (tools.canStart()) tools.startSummary();
      }
    });
    summarize.title = "Summarize linked comments locally. Fetching them may mark notifications read.";
    const stop = button("Stop summaries", "gns-text-button", () => {
      if (view) stopSummaries(view);
    });
    const settings = button("", "gns-icon-button gns-settings", openSummarySettings);
    settings.append(icon("M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3"));
    const reviewNote = element("p", "gns-review-note");
    const showCaughtUp = button("Show caught up (0)", "gns-text-button", () => {
      if (!view) return;
      view.showCaughtUp = !view.showCaughtUp;
      renderView(view);
    });
    showCaughtUp.setAttribute("aria-pressed", "false");
    const undo = button("Undo caught up", "gns-text-button", () => {
      if (view?.undoItem) return changeCaughtUp(view, view.undoItem, false);
    });
    undo.hidden = true;
    const note = element("p", "gns-footnote",
      "Caught up is local to this browser and account; it does not change GitHub's read or Done state. Loading or rechecking comments may mark notifications read. AI reviews one linked comment, not later replies; a request may already be answered.");

    const menuWrap = element("div", "gns-menu");
    const menuPanel = element("div", "gns-menu-panel");
    menuPanel.id = `gns-menu-${++detailsId}`;
    menuPanel.hidden = true;
    const menu = button("", "gns-icon-button gns-menu-button", () => setMenu(menuPanel.hidden));
    menu.append(icon("M3 8a1.25 1.25 0 1 0 0 .01M8 8a1.25 1.25 0 1 0 0 .01M13 8a1.25 1.25 0 1 0 0 .01", true));
    menu.setAttribute("aria-label", "Status and options");
    menu.setAttribute("aria-expanded", "false");
    menu.setAttribute("aria-controls", menuPanel.id);
    menu.title = "Search status, summary status, caught-up items, and notes";
    function setMenu(open) {
      menuPanel.hidden = !open;
      menu.setAttribute("aria-expanded", String(open));
    }
    menuWrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menuPanel.hidden) {
        setMenu(false);
        menu.focus();
      }
    });
    const listeners = new AbortController();
    document.addEventListener("click", (event) => {
      if (!menuPanel.hidden && !menuWrap.contains(event.target)) setMenu(false);
    }, { signal: listeners.signal });
    const section = (...nodes) => {
      const node = element("div", "gns-menu-section");
      node.append(...nodes);
      return node;
    };
    const unidentified = element("p", "gns-footnote gns-unidentified");
    unidentified.hidden = true;
    menuPanel.append(
      section(status),
      section(summaryNote),
      section(reviewNote, showCaughtUp),
      section(note, unidentified)
    );
    menuWrap.append(menu, menuPanel);
    actions.append(undo, pause, summarize, stop, refresh, settings, menuWrap, button("Manage list", "gns-button", openManager));
    header.append(heading, actions);

    const localError = element("p", "gns-local-error");
    localError.setAttribute("role", "alert");
    localError.hidden = true;
    const sweepBar = element("div", "gns-sweep-bar");
    sweepBar.dataset.gnsSweepBar = "";
    sweepBar.hidden = true;
    const sweepLabel = element("span", "gns-sweep-label", "Quick sweep (Read & Done):");
    const sweepReview = button("Review requested (0)", "gns-button gns-sweep-button", () => {
      if (view) return sweepNotifications(view, "review-requested");
    });
    sweepReview.dataset.gnsSweep = "review-requested";
    sweepReview.title = "Mark all Review requested notifications Read and Done on GitHub";
    const sweepTeam = button("Team mentioned (0)", "gns-button gns-sweep-button", () => {
      if (view) return sweepNotifications(view, "team-mention");
    });
    sweepTeam.dataset.gnsSweep = "team-mention";
    sweepTeam.title = "Mark all Team mentioned notifications Read and Done on GitHub";
    const sweepParticipating = button("Stale participating (0)", "gns-button gns-sweep-button", () => {
      if (view) return sweepNotifications(view, "stale-participating");
    });
    sweepParticipating.dataset.gnsSweep = "stale-participating";
    sweepParticipating.title = "Mark low-priority or closed Participating/Subscribed threads Read and Done on GitHub";
    const sweepAll = button("Sweep all noise (0)", "gns-button gns-sweep-button gns-sweep-all", () => {
      if (view) return sweepNotifications(view, "all");
    });
    sweepAll.dataset.gnsSweep = "all";
    sweepAll.title = "Mark all Review requested, Team mentioned, and stale Participating notifications Read and Done";
    const sweepStatus = element("span", "gns-sweep-status");
    sweepStatus.setAttribute("role", "status");
    sweepBar.append(sweepLabel, sweepReview, sweepTeam, sweepParticipating, sweepAll, sweepStatus);

    const briefingCard = element("section", "gns-today-briefing");
    briefingCard.dataset.gnsTodayBriefing = "";
    briefingCard.setAttribute("aria-label", "Morning executive briefing");
    briefingCard.hidden = mode !== "today";
    const briefingHeader = element("div", "gns-today-briefing-header");
    const briefingTitleWrap = element("div", "gns-today-briefing-titles");
    const briefingEyebrow = element("span", "gns-today-eyebrow", "Morning Executive Briefing");
    const briefingPill = element("span", "gns-today-pill", "Experimental · P1 Priority");
    briefingTitleWrap.append(briefingEyebrow, briefingPill);
    const briefingRegenerate = button("Regenerate briefing", "gns-text-button gns-today-regenerate", () => {
      if (view && view.mode === "today") {
        view.summariesPaused = false;
        view.briefingKey = "";
        view.briefingResult = null;
        view.briefingError = "";
        view.briefingRequest?.abort();
        view.briefingRequest = null;
        void updateTodayBriefing(view, true);
      }
    });
    briefingRegenerate.hidden = true;
    briefingHeader.append(briefingTitleWrap, briefingRegenerate);
    const briefingStatus = element("p", "gns-today-status");
    briefingStatus.setAttribute("role", "status");
    const briefingText = element("p", "gns-today-paragraph");
    briefingText.hidden = true;
    const briefingMeta = element("p", "gns-today-meta");
    briefingMeta.hidden = true;
    briefingCard.append(briefingHeader, briefingStatus, briefingText, briefingMeta);

    const error = element("p", "gns-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const list = element("ul", "gns-results");
    list.setAttribute("aria-label", "Matching notifications");
    const empty = element("div", "gns-empty");
    const emptyTitle = element("h3");
    const emptyText = element("p");
    const add = button("Add subscriptions", "gns-button gns-button-primary", openManager);
    empty.append(bookmark(), emptyTitle, emptyText, add);
    panel.append(header, briefingCard, sweepBar, localError, error, list, empty);
    if (root) root.before(panel);
    else (document.querySelector("main, [role='main']") || document.body).prepend(panel);
    return {
      mode, panel, title, nativeRoot: root, count, live, status, pause, unidentified, listeners, menuButton: menu, refresh, errorNode: error, list, empty,
      emptyTitle, emptyText, add, state: scanner.createState(INBOX), items: new Map(),
      rendered: new Map(), controller: null, previewController: new AbortController(), commentTools: new Map(),
      authors: new Map(), responses: new Map(), kevScores: new Map(), kevOffline: false, kevDone: false,
      priorityOrder: null, prioritySnapshot: null,
      briefingCard, briefingStatus, briefingText, briefingMeta, briefingRegenerate,
      briefingKey: "", briefingResult: null, briefingError: "", briefingRequest: null,
      sweepBar, sweepReview, sweepTeam, sweepParticipating, sweepAll, sweepStatus, sweeping: false, sweepMessage: "",
      summaryNote, summarize, stopSummaries: stop, summarySettingsButton: settings,
      reviewNote, showCaughtUpButton: showCaughtUp, undo, undoItem: null,
      localErrorNode: localError, localError: "", reviews: new Map(), reviewsReady: false,
      reviewVersion: 0, viewer: signedInLogin(), showCaughtUp: false,
      summaryQueue: [], activeSummaries: 0, activeTokens: 0,
      contextWindow: summaryApi.contextWindowForModel(summarySettings.model),
      modelCheckPromise: null, modelCheckModel: "", summariesPaused: false,
      paused: false, error: "", started: false, scanned: new Map(), cacheLoaded: false, checkedAt: 0,
      useDocument: !location.search, signature: mode + "|" + location.pathname + location.search + "|" + signedInLogin()
    };
  }

  function makeNativeView(root) {
    const toolbar = owned(element("div", "gns-actions gns-header-actions gns-native-toolbar"));
    toolbar.dataset.gnsNativeToolbar = "";
    const live = element("span", "gns-live");
    live.setAttribute("aria-hidden", "true");
    const summaryNote = element("p", "gns-summary-note");
    summaryNote.setAttribute("role", "status");
    const summarize = button("Summarize comments", "gns-button", () => {
      if (!nativeView) return;
      nativeView.summariesPaused = false;
      for (const tools of [...nativeView.commentTools.values()].sort((left, right) => right.priority() - left.priority())) {
        if (tools.canStart()) tools.startSummary();
      }
    });
    summarize.title = "Summarize linked comments locally. Fetching them may mark notifications read.";
    const stop = button("Stop summaries", "gns-text-button", () => {
      if (nativeView) stopSummaries(nativeView);
    });
    const settings = button("", "gns-icon-button gns-settings", openSummarySettings);
    settings.append(icon("M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3"));

    const note = element("p", "gns-footnote",
      "Loading or rechecking comments may mark notifications read. AI summarizes the linked comment or issue context; check the original before acting.");
    const menuWrap = element("div", "gns-menu");
    const menuPanel = element("div", "gns-menu-panel");
    menuPanel.id = `gns-menu-${++detailsId}`;
    menuPanel.hidden = true;
    const menu = button("", "gns-icon-button gns-menu-button", () => setMenu(menuPanel.hidden));
    menu.append(icon("M3 8a1.25 1.25 0 1 0 0 .01M8 8a1.25 1.25 0 1 0 0 .01M13 8a1.25 1.25 0 1 0 0 .01", true));
    menu.setAttribute("aria-label", "Status and options");
    menu.setAttribute("aria-expanded", "false");
    menu.setAttribute("aria-controls", menuPanel.id);
    menu.title = "Summary status and notes";
    function setMenu(open) {
      menuPanel.hidden = !open;
      menu.setAttribute("aria-expanded", String(open));
    }
    menuWrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menuPanel.hidden) {
        setMenu(false);
        menu.focus();
      }
    });
    const listeners = new AbortController();
    document.addEventListener("click", (event) => {
      if (!menuPanel.hidden && !menuWrap.contains(event.target)) setMenu(false);
    }, { signal: listeners.signal });
    const section = (...nodes) => {
      const node = element("div", "gns-menu-section");
      node.append(...nodes);
      return node;
    };
    menuPanel.append(section(summaryNote), section(note));
    menuWrap.append(menu, menuPanel);
    toolbar.append(live, summarize, stop, settings, menuWrap);

    return {
      isNative: true,
      toolbar,
      nativeRoot: root,
      live,
      listeners,
      menuButton: menu,
      previewController: new AbortController(),
      commentTools: new Map(),
      rowEntries: new Map(),
      authors: new Map(),
      responses: new Map(),
      kevScores: new Map(),
      kevOffline: false,
      summaryNote,
      summarize,
      stopSummaries: stop,
      summarySettingsButton: settings,
      reviews: new Map(),
      reviewsReady: true,
      reviewVersion: 0,
      localError: "",
      viewer: signedInLogin(),
      summaryQueue: [],
      activeSummaries: 0,
      activeTokens: 0,
      contextWindow: summaryApi.contextWindowForModel(summarySettings.model),
      modelCheckPromise: null,
      modelCheckModel: "",
      summariesPaused: false,
      state: { complete: true, running: false, rowCount: 0, pages: 1, unidentified: 0 },
      error: "",
      signature: location.pathname + location.search + "|" + signedInLogin()
    };
  }

  function renderSummaryControls(current) {
    if (view !== current && nativeView !== current) return;
    const tools = [...current.commentTools.values()];
    const pending = tools.filter((entry) => entry.pending()).length;
    const done = tools.filter((entry) => entry.finished()).length;
    const configured = !!summarySettings.model && !summarySettingsError;
    const manualOnly = Boolean(summarySettings.manualOnly);
    setText(current.summaryNote, summarySettingsError ? `AI settings need attention: ${summarySettingsError}` :
      !configured ? "Optional AI summaries run on this Mac or via your chosen provider. Choose a model to get started." :
      pending ? `${done} summarized / ${pending} waiting or running.` :
      `${done} summarized. ${current.summariesPaused ? "Summaries paused." : manualOnly ? "Manual row clicks only on." : summarySettings.automatic ? "Automatic summaries on." : "Automatic summaries off."} Loading comments may mark them read.`);
    current.summaryNote.dataset.failed = String(!!summarySettingsError);
    current.summarize.hidden = !configured || manualOnly;
    current.summarize.disabled = !ready || manualOnly || !tools.some((entry) => entry.canStart());
    current.stopSummaries.hidden = pending === 0;
    const settingsLabel = configured ? "AI settings" : "Set up local summaries";
    current.summarySettingsButton.setAttribute("aria-label", settingsLabel);
    current.summarySettingsButton.title = summarySettingsError ? `AI settings need attention: ${summarySettingsError}` : settingsLabel;
    current.summarySettingsButton.dataset.attention = String(!!summarySettingsError || !configured);
    current.summaryPending = pending;
    renderLive(current);
  }

  function renderLive(current) {
    const canScan = current.mode === "priority" || current.mode === "today" || subscriptions.size > 0;
    const searching = !current.isNative && !current.state.complete && !current.error && !storageError && ready && canScan;
    const hiddenNote = !current.isNative && current.hiddenCaughtUpCount > 0 && !current.showCaughtUp ?
      `${current.hiddenCaughtUpCount} caught up (hidden)` : "";
    const text = summarySettingsError ? "AI settings need attention" :
      searching ? (current.paused ? "Search paused" : `Searching... ${current.state.rowCount.toLocaleString()} checked`) :
        current.summaryPending ? `Summarizing ${current.summaryPending}...` : hiddenNote;
    setText(current.live, text);
    current.live.dataset.failed = String(!!summarySettingsError);
  }

  function checkModelOnce(current, model, signal) {
    if (current.modelCheckModel !== model || !current.modelCheckPromise) {
      current.modelCheckModel = model;
      const check = summaryClient.request({ type: "models", provider: summaryApi.providerForModel(model) }, {
        signal: current.previewController.signal
      }).then((models) => {
        if (!Array.isArray(models) || !models.some((entry) => entry.id === model)) {
          throw new Error("The selected local model is unavailable. Choose an installed model in AI settings.");
        }
        current.contextWindow = summaryApi.contextWindowForModel(model, models);
        return models;
      }).finally(() => {
        if (current.modelCheckPromise === check) {
          current.modelCheckPromise = null;
          current.modelCheckModel = "";
        }
      });
      current.modelCheckPromise = check;
    }
    const shared = current.modelCheckPromise;
    if (!signal) return shared;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(
        (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
      );
    });
  }

  function scheduleSummaries(current) {
    if (current.summaryDrainScheduled) return;
    current.summaryDrainScheduled = true;
    queueMicrotask(() => {
      current.summaryDrainScheduled = false;
      drainSummaries(current);
    });
  }

  function drainSummaries(current) {
    if (view !== current && nativeView !== current) return;
    current.summaryQueue.sort((left, right) => (right.priority || 0) - (left.priority || 0));
    while ((view === current || nativeView === current) && current.summaryQueue.length) {
      const job = current.summaryQueue[0];
      if (job.signal.aborted) {
        current.summaryQueue.shift();
        continue;
      }
      const limit = current.contextWindow || summaryApi.DEFAULT_CONTEXT_WINDOW;
      const tokens = job.tokens || summaryApi.estimateTokens({});
      const maxParallel = summaryApi.maxParallelSummaries(limit, tokens, summarySettings.model);
      if (current.activeSummaries > 0 && (current.activeTokens + tokens > limit || current.activeSummaries >= maxParallel)) {
        break;
      }
      current.summaryQueue.shift();
      current.activeSummaries += 1;
      current.activeTokens += tokens;
      void job.run().finally(() => {
        current.activeSummaries = Math.max(0, current.activeSummaries - 1);
        current.activeTokens = Math.max(0, current.activeTokens - tokens);
        if (view === current || nativeView === current) {
          scheduleSummaries(current);
          renderSummaryControls(current);
        }
      });
    }
    renderSummaryControls(current);
  }

  function stopSummaries(current, exceptKey, failedMessage = "") {
    current.summariesPaused = true;
    for (const [key, tools] of current.commentTools) {
      if (key !== exceptKey) tools.stopSummary(failedMessage);
    }
    current.summaryQueue.length = 0;
    renderSummaryControls(current);
  }

  function commentTools(item, current) {
    const details = element("details", "gns-preview");
    const exactTarget = core.commentTarget(item.href);
    const target = core.summaryTarget ? core.summaryTarget(item.href) : exactTarget;
    const disclosure = element("summary", "", exactTarget ? "Preview linked comment" : "Comment unavailable");
    if (exactTarget) disclosure.append(element("span", "gns-preview-caution", " (may mark read)"));
    const status = element("p", "gns-preview-status", exactTarget ?
      "Expand to load the exact linked comment from GitHub." : "GitHub did not include a supported comment link with this notification.");
    status.setAttribute("role", "status");
    const metadata = element("p", "gns-preview-meta");
    const text = element("div", "gns-preview-text");
    const source = element("a", "gns-text-link", "Open notification on GitHub");
    source.href = item.href;
    source.setAttribute("data-turbo", "false");
    const lifetime = new AbortController();
    let commentLoaded = false;
    let comment = null;
    let commentRequest = null;
    let summarySourceLoaded = false;
    let summarySource = null;
    let summarySourceRequest = null;
    let previewRequest = null;
    let summaryRequest = null;
    let phase = "idle";
    let cached = null;
    let cacheVersion = 0;
    let automaticAttempted = false;
    let responseListener = () => {};
    let stateListener = () => {};
    const retry = button("Retry preview", "gns-text-button", () => loadPreview());
    retry.hidden = true;
    const actions = element("div", "gns-actions");
    actions.append(source, retry);
    details.append(disclosure, status, metadata, text, actions);
    const ai = element("div", "gns-ai-summary");
    const aiLine = element("p", "gns-ai-line");
    const aiLabel = element("span", "gns-ai-label");
    const aiTruncatedPill = element("span", "gns-ai-truncated-pill", "Partial");
    aiTruncatedPill.title = "Summarized from a shortened comment preview";
    aiTruncatedPill.hidden = true;
    const aiText = element("span", "gns-ai-text");
    aiLine.append(aiLabel, aiTruncatedPill, aiText);
    let summaryExpanded = false;
    const aiToggle = button("Show more", "gns-text-button gns-ai-toggle", () => {
      summaryExpanded = !summaryExpanded;
      aiLine.dataset.expanded = String(summaryExpanded);
      updateSummaryToggle();
    });
    aiToggle.hidden = true;
    aiLine.addEventListener("click", () => {
      if (phase !== "done") return;
      if (!summaryExpanded && aiToggle.hidden) return;
      summaryExpanded = !summaryExpanded;
      aiLine.dataset.expanded = String(summaryExpanded);
      updateSummaryToggle();
    });
    const aiStatus = element("p", "gns-ai-status");
    aiStatus.setAttribute("role", "status");
    const aiButton = button("Summarize", "gns-text-button gns-ai-start", () => startSummary());
    aiButton.title = "Summarize this notification locally. Loading it may mark the notification read.";
    ai.append(aiLine, aiStatus, aiButton);
    const aiDetails = element("div", "gns-ai-details");
    const aiAction = element("p", "gns-ai-action");
    const aiCaution = element("p", "gns-ai-caution");
    const aiMetadata = element("p", "gns-ai-meta");
    const aiFreshness = element("p", "gns-ai-freshness");
    const evidence = element("details", "gns-ai-evidence");
    const evidenceHeading = element("summary", "", "Why this may need you");
    const evidenceText = element("blockquote");
    evidence.append(evidenceHeading, evidenceText);
    const recheck = button("Recheck comment (may mark read)", "gns-text-button", () => startSummary());
    aiDetails.append(aiAction, aiCaution, aiMetadata, aiFreshness, recheck);
    evidence.hidden = true;

    function unusedCommentRequest() {
      if (!previewRequest && !summaryRequest) {
        commentRequest?.controller.abort();
        summarySourceRequest?.controller.abort();
      }
    }

    function getComment(refresh = false) {
      if (refresh) {
        commentLoaded = false;
        comment = null;
        setText(text, "");
        setText(metadata, "");
        setText(status, "Rechecking the linked comment...");
      }
      if (commentLoaded) return Promise.resolve(comment);
      if (commentRequest && !commentRequest.controller.signal.aborted) return commentRequest.promise;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal, current.previewController.signal]);
      const request = { controller, promise: null };
      request.promise = preview.load(exactTarget, { signal }).then((value) => {
        signal.throwIfAborted();
        void restoreUnreadState(item);
        comment = value;
        commentLoaded = true;
        return value;
      }).finally(() => {
        if (commentRequest === request) commentRequest = null;
      });
      commentRequest = request;
      return request.promise;
    }

    function getSummarySource(refresh = false) {
      if (refresh) {
        summarySourceLoaded = false;
        summarySource = null;
        if (exactTarget) {
          commentLoaded = false;
          comment = null;
          setText(text, "");
          setText(metadata, "");
          setText(status, "Rechecking the linked comment...");
        }
      }
      if (exactTarget && commentLoaded && comment) return Promise.resolve(comment);
      if (summarySourceLoaded && summarySource) return Promise.resolve(summarySource);
      if (summarySourceRequest && !summarySourceRequest.controller.signal.aborted) return summarySourceRequest.promise;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal, current.previewController.signal]);
      const request = { controller, promise: null };
      request.promise = preview.load(target, { signal, allowFallback: true }).then((value) => {
        signal.throwIfAborted();
        void restoreUnreadState(item);
        const resolved = value || {
          text: [
            item.title || item.label,
            item.state ? `State: ${item.state}` : "",
            item.reason ? `Notification reason: ${item.reason}` : ""
          ].filter(Boolean).join("\n"),
          truncated: false,
          author: item.participants?.[0]?.username || "",
          dateTime: item.dateTime || ""
        };
        summarySource = resolved;
        summarySourceLoaded = true;
        if (exactTarget && value) {
          comment = value;
          commentLoaded = true;
        }
        return resolved;
      }).finally(() => {
        if (summarySourceRequest === request) summarySourceRequest = null;
      });
      summarySourceRequest = request;
      return request.promise;
    }

    async function loadPreview() {
      if (!exactTarget || previewRequest || !details.open) return;
      const token = {};
      previewRequest = token;
      setText(status, "Loading the linked comment...");
      retry.hidden = true;
      try {
        const loaded = await getComment();
        if (previewRequest !== token || !details.isConnected) return;
        if (!loaded) {
          setText(status, "The exact linked comment is not in GitHub's page HTML. It may be deleted, hidden, or loaded separately. Open the notification to read it.");
          return;
        }
        setText(status, loaded.truncated ? "Preview shortened. Open the notification for the full comment." : "Linked comment");
        setText(metadata, [loaded.author, loaded.dateTime ? new Date(loaded.dateTime).toLocaleString() : ""].filter(Boolean).join(" / "));
        setText(text, loaded.text);
      } catch (error) {
        if (previewRequest !== token || lifetime.signal.aborted || current.previewController.signal.aborted) return;
        setText(status, error.name === "TimeoutError" ? "The preview timed out. Retry or open the notification." :
          error instanceof TypeError ? "The preview could not be loaded. Check your connection and sign-in, then retry." : errorText(error));
        retry.hidden = false;
      } finally {
        if (previewRequest === token) previewRequest = null;
        unusedCommentRequest();
      }
    }

    function updateSummaryToggle() {
      if (phase !== "done" || !aiText.textContent) {
        aiToggle.hidden = true;
        aiToggle.remove();
        delete aiLine.dataset.expandable;
        return;
      }
      const overflows = aiLine.scrollHeight > aiLine.clientHeight + 1 || aiText.textContent.length > 160;
      const showToggle = summaryExpanded || overflows;
      aiToggle.hidden = !showToggle;
      if (showToggle) {
        if (!aiToggle.isConnected) aiLine.after(aiToggle);
        aiLine.dataset.expandable = "true";
        aiLine.title = summaryExpanded ? "Click to collapse summary" : "Click to read full summary";
      } else {
        aiToggle.remove();
        delete aiLine.dataset.expandable;
        aiLine.removeAttribute("title");
      }
      setText(aiToggle, summaryExpanded ? "Show less" : "Show more");
      aiToggle.setAttribute("aria-expanded", String(summaryExpanded));
    }

    function paintSummary() {
      ai.hidden = !target || !summarySettings.model;
      ai.dataset.state = phase;
      stateListener(phase, ai.dataset.response || "");
      aiDetails.hidden = ai.hidden || phase !== "done";
      aiLine.hidden = phase !== "done";
      aiLabel.hidden = phase !== "done" || !aiLabel.textContent;
      aiTruncatedPill.hidden = phase !== "done" || ai.dataset.truncated !== "true";
      aiButton.hidden = ["loading", "queued", "running", "unavailable", "done"].includes(phase);
      aiButton.disabled = !!summarySettingsError;
      setText(aiButton, phase === "error" ? "Retry summary" : "Summarize");
      recheck.hidden = phase !== "done";
      recheck.disabled = !!summarySettingsError;
      updateSummaryToggle();
      renderSummaryControls(current);
      if (view === current && current.mode === "today" && current.state?.complete) {
        void updateTodayBriefing(current);
      }
    }

    function clearSummary() {
      for (const node of [aiText, aiAction, aiCaution, aiMetadata, aiFreshness, evidenceText]) setText(node, "");
      evidence.hidden = true;
      evidence.open = false;
      evidence.remove();
      summaryExpanded = false;
      delete aiLine.dataset.expanded;
      delete aiLine.dataset.expandable;
      aiToggle.hidden = true;
      aiToggle.remove();
      delete ai.dataset.response;
      delete ai.dataset.truncated;
      aiTruncatedPill.hidden = true;
      setText(aiLabel, "");
      responseListener("");
    }

    function cleanTruncatedPhrasing(text) {
      if (typeof text !== "string") return "";
      const cleaned = text
        .replace(/\s*(?:Note:\s*)?(?:The|This)\s+(?:source|comment|text|input|excerpt)\s+(?:is|was|appears(?:\s+to\s+be)?)\s+(?:truncated|partial|shortened|incomplete|cut\s+off)[^.!?]*[.!?]/gi, "")
        .trim();
      return cleaned || text;
    }

    function viewerHasAskInText(text, actionText, viewer) {
      if (!viewer) return false;
      const escaped = viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (actionText && new RegExp(`^(?:@?${escaped}|you)\\b`, "i").test(actionText.trim())) {
        return true;
      }
      const askToViewer = new RegExp(
        `(?:@${escaped}\\s+(?:needs?\\s+to|should|must|to\\s+)|` +
        `(?:asked|asking|needs?|waiting\\s+(?:on|for)|assigned\\s+(?:to)?|pinged|requested(?:\\s+that)?)\\s+@${escaped}\\b|` +
        `\\byou\\s+(?:need\\s+to|should|must)\\b|` +
        `(?:asked|asking|waiting\\s+(?:on|for))\\s+you\\b)`,
        "i"
      );
      return askToViewer.test(text);
    }

    function rewriteViewerAsYou(text, viewer) {
      if (!text || !viewer) return text;
      const escaped = viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text
        .replace(new RegExp(`(^|[.!?]\\s+)@?${escaped}\\s+needs\\s+to\\b`, "gi"), "$1You need to")
        .replace(new RegExp(`\\b@?${escaped}\\s+needs\\s+to\\b`, "gi"), "you need to")
        .replace(new RegExp(`(^|[.!?]\\s+)@?${escaped}\\s+should\\b`, "gi"), "$1You should")
        .replace(new RegExp(`\\b@?${escaped}\\s+should\\b`, "gi"), "you should")
        .replace(new RegExp(`\\b(asked|asking|needs|tell|told|pinged|reminded|assigned|waiting\\s+on|waiting\\s+for)\\s+@${escaped}\\b`, "gi"), "$1 you")
        .replace(new RegExp(`\\bfor\\s+@${escaped}\\s+to\\b`, "gi"), "for you to");
    }

    function formatActionableSummary(summaryText, result) {
      const viewer = current.viewer || signedInLogin();
      let base = cleanTruncatedPhrasing(summaryText);
      if (!base) return "";
      const hasViewerAsk = result.response === "needs_response" || viewerHasAskInText(base, result.action, viewer);
      base = rewriteViewerAsYou(base, viewer)
        .replace(/\s*(?:[—–-]\s*)?Nothing(?:\s+seems\s+to\s+be)?\s+needed\s+from\s+you[^.!?]*[.!?]?/gi, "")
        .trim();
      const hasExplicitTakeaway = /(?:needs\s+from\s+you|\byou\s+(?:need\s+to|should)\b|\basked\s+you\s+to\b)/i.test(base);
      const cleanAction = rewriteViewerAsYou(result.action || "", viewer).replace(/^(?:you|@[\w-]+):\s*/i, "");
      if (hasViewerAsk) {
        if (cleanAction && !hasExplicitTakeaway && !base.toLowerCase().includes(cleanAction.replace(/\.$/, "").toLowerCase())) {
          return `${base.endsWith(".") ? base : `${base}.`} Needs from you: ${cleanAction}`;
        }
        return base;
      }
      if (result.response === "unclear" && result.action && !hasExplicitTakeaway) {
        const normalizedBase = base.toLowerCase();
        const normalizedAction = result.action.replace(/\.$/, "").toLowerCase();
        if (!normalizedBase.includes(normalizedAction)) {
          return `${base.endsWith(".") ? base : `${base}.`} Open ask: ${result.action}`;
        }
      }
      return base;
    }

    function showSummary(record, checkedNow) {
      const result = record.result;
      const viewer = current.viewer || signedInLogin();
      const effectiveResponse = result.response !== "needs_response" && viewerHasAskInText(result.summary, result.action, viewer) ?
        "needs_response" : result.response;
      phase = "done";
      ai.dataset.response = effectiveResponse;
      ai.dataset.truncated = String(!!record.truncated);
      aiTruncatedPill.hidden = !record.truncated;
      if (current.responses) current.responses.set(item.key, effectiveResponse);
      if (current.authors && record.author) current.authors.set(item.key, record.author);
      responseListener(effectiveResponse);
      setText(aiLabel, effectiveResponse === "needs_response" ? "Needs your response" :
        effectiveResponse === "fyi" ? "FYI" : "Unclear ask");
      setText(aiStatus, "");
      setText(aiText, formatActionableSummary(result.summary, { ...result, response: effectiveResponse }));
      updateSummaryToggle();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => updateSummaryToggle());
      }
      const formattedAction = rewriteViewerAsYou(result.action || "", viewer);
      setText(aiAction, formattedAction ? `Request: ${formattedAction}` : "");
      evidence.hidden = !result.evidence;
      if (result.evidence) aiAction.after(evidence);
      setText(evidenceText, result.evidence);
      const isCloud = Boolean(summaryApi.isCloudProvider?.(summaryApi.providerForModel(record.model || summarySettings.model)));
      setText(aiCaution, record.truncated ? "Based on a shortened comment. Check the original for omitted details." : "");
      setText(aiMetadata, [`${result.response === "needs_response" ? "Needs your response" :
        result.response === "fyi" ? "FYI" : "Recipient unclear"} (${isCloud ? "cloud AI" : "local AI"})`,
      record.author ? `Source: ${record.author.startsWith("@") ? record.author : "@" + record.author}` : "Source author unavailable",
      record.dateTime ? new Date(record.dateTime).toLocaleString() : ""].filter(Boolean).join(" / "));
      const when = new Date(record.checkedAt).toLocaleString();
      setText(aiFreshness, record.persisted === false ? "Not saved: signed-in username unavailable." :
        checkedNow ? `${record.reused ? "Source unchanged; reused summary." : "Saved locally."} Source checked ${when}.` :
          `Saved summary. Source checked ${when}; not rechecked this visit.`);
    }

    async function loadSaved(allowAutomatic = false) {
      const version = ++cacheVersion;
      if (summaryRequest || lifetime.signal.aborted) return;
      if (!target || !summarySettings.model) {
        paintSummary();
        return;
      }
      const model = summarySettings.model;
      const memKey = memorySummaryKey(current.viewer, model, item.key);
      const activity = storeApi.activityToken(item);
      const visitKey = tabCheckKey(current.viewer, model, item.key, activity);
      if (checkedInThisTab.has(visitKey)) {
        automaticAttempted = true;
      }
      const memRecord = memKey ? memorySummaries.get(memKey) : null;
      if (memRecord && (!activity || !memRecord.activity || memRecord.activity === activity)) {
        if (memRecord.fingerprint !== cached?.fingerprint && (commentLoaded || commentRequest || summarySourceLoaded || summarySourceRequest)) {
          previewRequest = null;
          commentRequest?.controller.abort();
          summarySourceRequest?.controller.abort();
          commentLoaded = false;
          comment = null;
          summarySourceLoaded = false;
          summarySource = null;
          details.open = false;
          setText(text, "");
          setText(metadata, "");
          setText(status, "The saved summary changed. Expand to reload its exact source.");
        }
        cached = memRecord;
        automaticAttempted = true;
        checkedInThisTab.add(visitKey);
        clearSummary();
        showSummary(memRecord, false);
        paintSummary();
        return;
      }
      phase = "loading";
      setText(aiStatus, current.isNative ? "" : "Looking for a saved summary...");
      paintSummary();
      try {
        const record = current.viewer ? await store.getCachedSummary(current.viewer, item, model, false) : null;
        if (version !== cacheVersion || lifetime.signal.aborted || (view !== current && nativeView !== current) || model !== summarySettings.model) return;
        if (record && record.fingerprint !== cached?.fingerprint && (commentLoaded || commentRequest || summarySourceLoaded || summarySourceRequest)) {
          previewRequest = null;
          commentRequest?.controller.abort();
          summarySourceRequest?.controller.abort();
          commentLoaded = false;
          comment = null;
          summarySourceLoaded = false;
          summarySource = null;
          details.open = false;
          setText(text, "");
          setText(metadata, "");
          setText(status, "The saved summary changed. Expand to reload its exact source.");
        }
        const currentActivity = storeApi.activityToken(item);
        const matchesActivity = record && (!currentActivity || !record.activity || record.activity === currentActivity);
        cached = record;
        if (memKey) {
          if (record && matchesActivity) memorySummaries.set(memKey, record);
          else if (!record) memorySummaries.delete(memKey);
        }
        clearSummary();
        setText(aiStatus, "");
        if (matchesActivity) {
          showSummary(record, false);
          if (current.isNative) {
            automaticAttempted = true;
            checkedInThisTab.add(visitKey);
          }
        } else {
          phase = "idle";
        }
        paintSummary();
        if (allowAutomatic && summarySettings.automatic && !summarySettings.manualOnly && current.reviewsReady && !caughtUp(current, item) && !automaticAttempted) {
          startSummary(true);
        }
      } catch (error) {
        if (version !== cacheVersion || lifetime.signal.aborted) return;
        phase = "error";
        clearSummary();
        setText(aiStatus, errorText(error));
        paintSummary();
      }
    }

    function startSummary(automatic = false) {
      if (!target || !summarySettings.model || summarySettingsError ||
          ["loading", "queued", "running", "unavailable"].includes(phase) || lifetime.signal.aborted) return;
      const visitKey = tabCheckKey(current.viewer, summarySettings.model, item.key, storeApi.activityToken(item));
      if (automatic && (!["idle", "done"].includes(phase) || current.summariesPaused || summarySettings.manualOnly ||
          !current.reviewsReady || caughtUp(current, item) || automaticAttempted || checkedInThisTab.has(visitKey))) return;
      automaticAttempted = true;
      checkedInThisTab.add(visitKey);
      const recheck = phase === "done";
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal, current.previewController.signal]);
      summaryRequest = controller;
      const model = summarySettings.model;
      const isCloud = Boolean(summaryApi.isCloudProvider?.(summaryApi.providerForModel(model)));
      phase = "queued";
      clearSummary();
      setText(aiStatus, isCloud ? "Waiting to summarize with cloud model..." : "Waiting to summarize locally...");
      paintSummary();
      const initialTokens = summaryApi.estimateTokens({
        title: core.cleanText(item.title, 500),
        viewer: current.viewer,
        text: commentLoaded && comment ? comment.text : ""
      });
      const initialPriority = computeItemPriority(current, item).score;
      current.summaryQueue.push({ signal, tokens: initialTokens, priority: initialPriority, run: async () => {
        try {
          signal.throwIfAborted();
          phase = "running";
          setText(aiStatus, isCloud ? "Checking the cloud model..." : "Checking the local model...");
          paintSummary();
          if (!cached) {
            await checkModelOnce(current, model, signal);
            signal.throwIfAborted();
          }
          setText(aiStatus, "Loading notification details...");
          const loaded = await getSummarySource(recheck);
          signal.throwIfAborted();
          if (current.authors && loaded.author) current.authors.set(item.key, loaded.author);
          if (!current.kevOffline && !current.kevScores?.has(item.key)) {
            summaryClient.request({
              type: "triage",
              href: `${target.url}#${target.id}`,
              title: core.cleanText(item.title, 500),
              reason: item.reason || "",
              author: loaded.author,
              viewer: current.viewer,
              text: loaded.text
            }, { signal }).then((kevResult) => {
              if (!kevResult) {
                current.kevOffline = true;
                return;
              }
              current.kevScores?.set(item.key, kevResult);
              if (phase !== "done" && kevResult.response) responseListener(kevResult.response);
              if (view === current) renderView(current);
            }).catch(() => {
              current.kevOffline = true;
            });
          }
          const summaryHref = `${target.url}#${target.id}`;
          const tokens = summaryApi.estimateTokens({
            title: core.cleanText(item.title, 500),
            author: loaded.author,
            viewer: current.viewer,
            text: loaded.text,
            truncated: loaded.truncated
          });
          const priorityScore = computeItemPriority(current, item).score;
          const record = await summaryClient.request({
            type: "summarize", model, href: summaryHref, title: core.cleanText(item.title, 500),
            viewer: current.viewer, activity: storeApi.activityToken(item),
            author: loaded.author, dateTime: loaded.dateTime, text: loaded.text, truncated: loaded.truncated,
            tokens, contextWindow: current.contextWindow || summaryApi.contextWindowForModel(model),
            priority: priorityScore
          }, {
            signal,
            onProgress: (message) => {
              if (!signal.aborted) setText(aiStatus, message);
            }
          });
          signal.throwIfAborted();
          cached = record.persisted ? record : null;
          const memKey = memorySummaryKey(current.viewer, model, item.key);
          if (memKey) memorySummaries.set(memKey, record);
          checkedInThisTab.add(tabCheckKey(current.viewer, model, item.key, storeApi.activityToken(item)));
          showSummary(record, true);
          if (details.open) void loadPreview();
        } catch (error) {
          if (signal.aborted) return;
          phase = "error";
          let message = errorText(error);
          if (cached && current.viewer) {
            try {
              await localAction({ type: "gns:discard-summary", viewer: current.viewer, item });
              cached = null;
            } catch (storageFailure) {
              message += ` Saved summary could not be cleared: ${errorText(storageFailure)}`;
            }
          }
          setText(aiStatus, message);
          stopSummaries(current, item.key, message);
        } finally {
          if (summaryRequest === controller) {
            summaryRequest = null;
            unusedCommentRequest();
            paintSummary();
          }
        }
      } });
      scheduleSummaries(current);
    }

    function stopSummary(failedMessage = "") {
      if (!summaryRequest) return;
      summaryRequest.abort();
      summaryRequest = null;
      phase = failedMessage ? "error" : "stopped";
      setText(aiStatus, failedMessage || "Summary stopped.");
      unusedCommentRequest();
      paintSummary();
    }

    function settingsChanged(reset) {
      if (reset) {
        stopSummary();
        phase = "idle";
        cached = null;
        clearSummary();
        setText(aiStatus, "");
      }
      paintSummary();
      if (reset || phase === "idle") void loadSaved(true);
      else if (summarySettings.automatic) startSummary(true);
    }

    function cacheChanged(changes) {
      const reset = Object.hasOwn(changes, storeApi.CACHE_RESET_KEY);
      const change = current.viewer ? changes[storeApi.cacheKey(current.viewer, item.key)] : null;
      if (!reset && (!change || summaryRequest)) return;
      const memKey = memorySummaryKey(current.viewer, summarySettings.model, item.key);
      if (reset) {
        memorySummaries.clear();
        checkedInThisTab.clear();
      } else if (!change.newValue) {
        if (memKey) memorySummaries.delete(memKey);
      } else {
        if (memKey) memorySummaries.set(memKey, change.newValue);
        if (cached && cached.fingerprint === change.newValue.fingerprint && phase === "done") {
          return;
        }
      }
      if (reset || !change.newValue) {
        ++cacheVersion;
        stopSummary();
        cached = null;
        clearSummary();
        phase = "stopped";
        setText(aiStatus, "Saved summary cleared. Summarize again when ready.");
        paintSummary();
      } else void loadSaved(false);
    }

    details.addEventListener("toggle", () => {
      if (details.open) void loadPreview();
      else {
        previewRequest = null;
        unusedCommentRequest();
      }
    });
    return {
      preview: details, summary: ai, summaryDetails: aiDetails, startSummary,
      onResponse: (listener) => {
        responseListener = listener;
        listener(ai.dataset.response || "");
      },
      onStateChange: (listener) => {
        stateListener = listener;
        listener(phase, ai.dataset.response || "");
      },
      stopSummary, settingsChanged, cacheChanged,
      reviewChanged: () => {
        if (summarySettings.automatic) startSummary(true);
      },
      pending: () => ["queued", "running"].includes(phase),
      priority: () => computeItemPriority(current, item).score,
      finished: () => phase === "done",
      failed: () => phase === "error",
      errorMessage: () => aiStatus.textContent || "",
      getSummaryRecord: () => cached,
      canAutoStart: () => !!target && !caughtUp(current, item) && phase === "idle",
      canStart: () => !!target && !caughtUp(current, item) && !["loading", "queued", "running", "done", "unavailable"].includes(phase),
      cancel: () => {
        lifetime.abort();
        previewRequest = null;
        stopSummary();
      }
    };
  }

  function icon(d, filled = false) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    if (filled) path.setAttribute("fill", "currentColor");
    else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.append(path);
    return svg;
  }

  let detailsId = 0;

  const KIND_ICONS = {
    issue: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5ZM8 7.25a.75.75 0 1 0 0 1.5.75.75 0 1 0 0-1.5Z",
    pull: "M4.5 2.5v11M4.5 2.5a1.5 1.5 0 1 0 0 .01M11.5 13.5a1.5 1.5 0 1 0 0-.01M11.5 12V6.5a2 2 0 0 0-2-2H7M8.5 3 7 4.5 8.5 6",
    discussion: "M2.5 3.5h8v6h-4l-2.5 2v-2h-1.5ZM10.5 6h3v6H12v2l-2.5-2H7",
    release: "M8.5 2.5h5v5l-6 6-5-5ZM11 5a.5.5 0 1 0 0 .01",
    other: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5Z"
  };
  const RESPONSE_KINDS = {
    needs_response: {
      label: "Needs your response",
      path: "M6.5 4 3 7.5 6.5 11M3 7.5h6.5a4 4 0 0 1 4 4v1"
    },
    fyi: {
      label: "FYI",
      path: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5ZM8 7.25v4M8 4.75v.01"
    },
    unclear: {
      label: "Recipient unclear",
      path: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5ZM6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15M8 11.25v.01"
    }
  };

  function relativeTime(dateTime, now = Date.now()) {
    const then = Date.parse(dateTime);
    if (!Number.isFinite(then)) return "";
    const seconds = Math.round((now - then) / 1000);
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86400000);
    if (seconds < 45) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 24 && days < 1) return `${hours} hr ago`;
    if (days <= 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    if (days < 28) return `${Math.floor(days / 7)} wk ago`;
    const date = new Date(then);
    return date.toLocaleDateString(undefined, date.getFullYear() === new Date(now).getFullYear() ?
      { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }

  function refreshTimes() {
    for (const node of document.querySelectorAll("time.gns-time[datetime]")) {
      setText(node, relativeTime(node.dateTime) || node.textContent);
    }
  }

  setInterval(refreshTimes, 60000);

  function paintKind(kind, item, response) {
    const known = RESPONSE_KINDS[response];
    const typeLabel = core.TYPE_LABELS[item.type] || "Notification";
    kind.replaceChildren(icon(known ? known.path : KIND_ICONS[item.type] || KIND_ICONS.other));
    kind.dataset.kind = response || item.type || "other";
    kind.dataset.state = known ? "" : (item.state || "").toLowerCase().replace(/\s+/g, "-");
    const label = known ? `${known.label} (local AI) / ${typeLabel}` : [typeLabel, item.state].filter(Boolean).join(" / ");
    kind.setAttribute("aria-label", label);
    kind.title = label;
  }

  const VISIBLE_PARTICIPANTS = 3;

  function rowSignals(item, current) {
    const isPriority = current?.mode === "priority" || current?.mode === "today";
    if (!isPriority && !item.repository && !item.reason && !item.participants.length) return null;
    const line = element("div", "gns-signals");
    if (isPriority) {
      const priority = computeItemPriority(current, item);
      const badge = element("span", "gns-priority-badge", `${priority.tier} · ${priority.score}`);
      badge.dataset.tier = priority.tier;
      badge.title = priority.breakdown;
      line.append(badge);
    }
    if (item.repository) {
      const repoPill = element("span", "gns-repo-pill", item.repository);
      repoPill.title = `Repository: ${item.repository}`;
      line.append(repoPill);
    }
    if (isPriority) {
      const priority = computeItemPriority(current, item);
      if (priority.orgMatch) {
        const org = element("span", "gns-org-signal", `${priority.orgMatch.role}: @${priority.orgMatch.username}`);
        org.title = `Organizational hierarchy signal (+${priority.orgScore} pts)`;
        line.append(org);
      }
    }
    if (item.reason) {
      const reason = element("span", "gns-reason", item.reason.replace(/[-_]+/g, " "));
      reason.title = item.reasonDescription || `Reason: ${item.reason}`;
      line.append(reason);
    }
    if (item.participants.length) {
      const names = item.participants.map((person) => `@${person.username}`);
      const extra = names.length - VISIBLE_PARTICIPANTS;
      const participants = element("span", "gns-participants",
        names.slice(0, VISIBLE_PARTICIPANTS).join(", ") + (extra > 0 ? ` +${extra}` : ""));
      participants.title = `Participants: ${names.join(", ")}`;
      line.append(participants);
    }
    return line;
  }

  function resultRow(item, current) {
    const row = element("li", "gns-result");
    row.dataset.activity = storeApi.activityToken(item);
    row.dataset.unread = String(item.unread);
    const dot = element("span", "gns-unread-dot");
    dot.title = item.unread ? "Unread" : "Read";
    dot.setAttribute("aria-label", dot.title);
    const main = element("div", "gns-result-main");
    const kind = element("span", "gns-kind");
    kind.setAttribute("role", "img");
    paintKind(kind, item, "");
    const link = element("a", "gns-result-link");
    link.href = item.href;
    link.setAttribute("data-turbo", "false");
    link.title = item.label;
    const title = element("span", "gns-result-title", item.title);
    link.append(title);
    const number = item.label.match(/#\d+$/)?.[0];
    if (number) link.append(" ", element("span", "gns-result-number", number));
    const heading = element("div", "gns-result-heading");
    heading.append(link);
    const signals = rowSignals(item, current);
    if (signals) heading.append(signals);
    main.append(kind, heading);
    const tools = commentTools(item, current);
    current.commentTools.set(item.key, tools);
    tools.onResponse((response) => paintKind(kind, item, response));
    const activity = element("div", "gns-result-activity");
    activity.append(tools.summary);

    const aside = element("div", "gns-result-aside");
    if (item.dateTime) {
      const time = element("time", "gns-time", relativeTime(item.dateTime) || item.timeText);
      time.dateTime = item.dateTime;
      time.title = new Date(item.dateTime).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
      aside.append(time);
    }
    const review = button("", "gns-icon-button gns-caught-up", async (node) => {
      node.disabled = true;
      await changeCaughtUp(current, item, !caughtUp(current, item));
      if (node.isConnected) node.disabled = !current.viewer || !current.reviewsReady || !storeApi.activityToken(item);
    });
    review.append(icon("M3 8.5l3.2 3L13 4.5"));
    const drawer = element("div", "gns-result-details");
    drawer.id = `gns-details-${++detailsId}`;
    drawer.hidden = true;
    const more = button("", "gns-icon-button gns-more", () => {
      drawer.hidden = !drawer.hidden;
      more.setAttribute("aria-expanded", String(!drawer.hidden));
      row.dataset.expanded = String(!drawer.hidden);
    });
    more.append(icon("M3 8a1.25 1.25 0 1 0 0 .01M8 8a1.25 1.25 0 1 0 0 .01M13 8a1.25 1.25 0 1 0 0 .01", true));
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", drawer.id);
    more.setAttribute("aria-label", `More details: ${item.label}`);
    more.title = "Details, comment preview, and more actions";
    aside.append(review, more);

    const context = element("div", "gns-result-context");
    const metadata = element("span", "gns-result-meta", `${core.TYPE_LABELS[item.type]} / ${item.label}`);
    if (item.state) metadata.append(element("span", "gns-item-state", item.state));
    context.append(metadata);
    if (item.participants.length) {
      const participants = element("span", "gns-participant-links", "Participants: ");
      item.participants.forEach((person, index) => {
        if (index) participants.append(", ");
        const profile = element("a", "", `@${person.username}`);
        profile.href = person.url;
        participants.append(profile);
      });
      context.append(participants);
    }
    const remove = createPin(item);
    remove.classList.add("gns-pin-labeled");
    remove.append(element("span", "", "Remove from list"));
    const footer = element("div", "gns-actions gns-details-actions");
    footer.append(remove);
    drawer.append(context, tools.summaryDetails, tools.preview, footer);
    row.append(dot, main, activity, aside, drawer);
    return row;
  }

  function renderSavedTodayBriefing(current, saved) {
    current.briefingResult = saved;
    current.briefingStatus.hidden = true;
    current.briefingText.hidden = false;
    setText(current.briefingText, saved.briefing);
    current.briefingMeta.hidden = false;
    const wordCount = saved.briefing.trim().split(/\s+/).filter(Boolean).length;
    const timeLabel = saved.generatedAt ?
      new Date(saved.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const countLabel = saved.itemCount ?
      `Synthesized from ${saved.itemCount} P1 ${saved.itemCount === 1 ? "notification" : "notifications"}` :
      "Saved for today";
    setText(current.briefingMeta, [
      countLabel,
      timeLabel ? `saved today at ${timeLabel}` : "",
      `${wordCount} words`,
      `Local AI (${saved.model || summarySettings.model})`
    ].filter(Boolean).join(" · "));
    current.briefingRegenerate.hidden = false;
  }

  async function loadSavedTodayBriefing(viewer, model) {
    const storageKey = todayBriefingStorageKey(viewer);
    const now = Date.now();
    const mem = memoryBriefings.get(storageKey);
    if (mem && mem.model === model && sameLocalDay(mem.generatedAt, now)) {
      return mem;
    }
    try {
      const stored = (await chrome.storage.local.get(storageKey))?.[storageKey];
      if (stored && typeof stored.briefing === "string" && stored.briefing.trim() &&
          stored.model === model && Number.isFinite(stored.generatedAt) && sameLocalDay(stored.generatedAt, now)) {
        memoryBriefings.set(storageKey, stored);
        return stored;
      }
    } catch {
      // Ignore storage read failure and fall back to fresh generation.
    }
    return null;
  }

  async function saveTodayBriefingForDay(viewer, record) {
    const storageKey = todayBriefingStorageKey(viewer);
    memoryBriefings.set(storageKey, record);
    try {
      await chrome.storage.local.set({ [storageKey]: record });
    } catch {
      // In-memory cache still holds today's briefing if storage write fails.
    }
  }

  async function updateTodayBriefing(current, force = false) {
    if (!current || current.mode !== "today" || view !== current || !current.briefingCard) return;
    current.briefingCard.hidden = false;
    const activeBriefingModel = summarySettings.briefingModel || summarySettings.model;
    if (!activeBriefingModel || summarySettingsError) {
      current.briefingStatus.hidden = false;
      setText(current.briefingStatus, summarySettingsError ?
        `AI settings need attention: ${summarySettingsError}` :
        "Choose a local or cloud model in AI settings to generate your morning executive briefing.");
      current.briefingText.hidden = true;
      current.briefingMeta.hidden = true;
      current.briefingRegenerate.hidden = true;
      return;
    }

    if (!force) {
      const savedToday = await loadSavedTodayBriefing(current.viewer, activeBriefingModel);
      if (view !== current || current.mode !== "today") return;
      if (savedToday) {
        current.briefingKey = `saved-day|${savedToday.generatedAt}`;
        renderSavedTodayBriefing(current, savedToday);
        return;
      }
    }

    if (!current.state.complete) {
      current.briefingStatus.hidden = false;
      setText(current.briefingStatus, "Scanning your inbox for P1 notifications...");
      current.briefingText.hidden = true;
      current.briefingMeta.hidden = true;
      current.briefingRegenerate.hidden = true;
      return;
    }
    const p1Items = [...current.rendered.keys()].map((key) => current.items.get(key)).filter(Boolean);
    if (!p1Items.length) {
      current.briefingStatus.hidden = true;
      current.briefingText.hidden = false;
      setText(current.briefingText, "No P1 fires are waiting on you right now. Your inbox is clear of urgent blockers and direct leadership asks.");
      current.briefingMeta.hidden = true;
      current.briefingRegenerate.hidden = true;
      return;
    }
    let waitingCount = 0;
    let startedAny = false;
    let firstFailedMessage = "";
    for (const item of p1Items) {
      const tools = current.commentTools.get(item.key);
      if (!tools) continue;
      if (force ? tools.canStart() : tools.canAutoStart()) {
        tools.startSummary();
        startedAny = true;
        waitingCount += 1;
      } else if (tools.failed?.() && !firstFailedMessage) {
        firstFailedMessage = tools.errorMessage?.() || "A P1 notification summary failed.";
      } else if (!tools.finished()) {
        waitingCount += 1;
      }
    }
    if (firstFailedMessage && waitingCount === 0 && !startedAny) {
      current.briefingStatus.hidden = false;
      setText(current.briefingStatus, `Morning briefing paused: ${firstFailedMessage}`);
      current.briefingRegenerate.hidden = false;
      return;
    }
    if (waitingCount > 0 || startedAny) {
      const doneCount = p1Items.length - waitingCount;
      current.briefingStatus.hidden = false;
      setText(current.briefingStatus, `Reading P1 threads (${doneCount} of ${p1Items.length} summarized) before writing your morning briefing...`);
      if (!current.briefingResult) {
        current.briefingText.hidden = true;
        current.briefingMeta.hidden = true;
      }
      current.briefingRegenerate.hidden = true;
      return;
    }

    const briefingItems = [];
    for (const item of p1Items) {
      const tools = current.commentTools.get(item.key);
      const record = tools?.getSummaryRecord?.() ||
        memorySummaries.get(memorySummaryKey(current.viewer, summarySettings.model, item.key));
      if (!record?.result) continue;
      const priority = computeItemPriority(current, item);
      briefingItems.push({
        label: item.label,
        title: item.title,
        author: record.author || item.participants?.[0]?.username || "",
        role: priority.orgMatch?.role || "",
        reason: item.reason || "",
        score: priority.score,
        response: current.responses.get(item.key) || record.result.response || "unclear",
        summary: record.result.summary,
        action: record.result.action || "",
        evidence: record.result.evidence || ""
      });
    }
    if (!briefingItems.length) return;

    const key = [
      current.viewer || "anon",
      activeBriefingModel,
      ...briefingItems.map((entry) => `${entry.label}:${entry.score}:${entry.response}:${entry.summary}`)
    ].join("|");

    if (!force && current.briefingKey === key && (current.briefingRequest || current.briefingResult || current.briefingError)) {
      return;
    }

    current.briefingRequest?.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, current.previewController.signal]);
    current.briefingRequest = controller;
    current.briefingKey = key;
    current.briefingError = "";
    current.briefingStatus.hidden = false;
    setText(current.briefingStatus, `Drafting your morning executive briefing with ${activeBriefingModel}...`);
    current.briefingRegenerate.hidden = true;

    try {
      const result = await summaryClient.request({
        type: "briefing",
        model: activeBriefingModel,
        viewer: current.viewer,
        items: briefingItems
      }, {
        signal,
        onProgress: (message) => {
          if (!signal.aborted && view === current) {
            setText(current.briefingStatus, message);
          }
        }
      });
      signal.throwIfAborted();
      if (view !== current) return;
      const savedRecord = {
        briefing: result.briefing,
        generatedAt: Date.now(),
        model: activeBriefingModel,
        itemCount: briefingItems.length
      };
      await saveTodayBriefingForDay(current.viewer, savedRecord);
      if (view !== current) return;
      renderSavedTodayBriefing(current, savedRecord);
    } catch (error) {
      if (signal.aborted || view !== current) return;
      current.briefingError = errorText(error);
      current.briefingStatus.hidden = false;
      setText(current.briefingStatus, `Morning briefing could not be generated: ${current.briefingError}`);
      current.briefingRegenerate.hidden = false;
    } finally {
      if (current.briefingRequest === controller) {
        current.briefingRequest = null;
      }
    }
  }

  function renderView(current) {
    if (view !== current) return;
    const isToday = current.mode === "today";
    const isPriority = current.mode === "priority" || isToday;
    if (isPriority && current.state.complete && !current.priorityOrder) {
      lockPrioritySnapshot(current);
    }
    const allPriorityMatches = !ready ? [] :
      (current.priorityOrder ?
        current.priorityOrder.map((key) => current.items.get(key)).filter(Boolean) :
        [...current.items.values()]
          .map((item) => ({ item, priority: computeItemPriority(current, item) }))
          .filter(({ priority }) => priority.qualifies)
          .sort((left, right) => right.priority.score - left.priority.score ||
            (Date.parse(right.item.dateTime || "") || 0) - (Date.parse(left.item.dateTime || "") || 0))
          .map(({ item }) => item));
    const matches = !ready ? [] : isToday ?
      allPriorityMatches.filter((item) => computeItemPriority(current, item).tier === "P1") :
      isPriority ? allPriorityMatches :
      [...current.items.values()].filter((item) => subscriptions.has(item.key));
    const reviewed = matches.filter((item) => caughtUp(current, item));
    const visible = current.showCaughtUp ? matches : matches.filter((item) => !caughtUp(current, item));
    const keys = new Set(visible.map((item) => item.key));
    let moveFocus = false;
    for (const [key, node] of current.rendered) {
      if (!keys.has(key) || node.dataset.activity !== storeApi.activityToken(current.items.get(key))) {
        if (node.contains(document.activeElement)) moveFocus = true;
        current.commentTools.get(key)?.cancel();
        current.commentTools.delete(key);
        node.remove();
        current.rendered.delete(key);
      }
    }
    for (const item of visible) {
      let node = current.rendered.get(item.key);
      if (!node) {
        node = resultRow(item, current);
        current.rendered.set(item.key, node);
        current.list.append(node);
        current.commentTools.get(item.key).settingsChanged(false);
      }
      node.dataset.unread = String(item.unread);
      const dot = node.querySelector(".gns-unread-dot");
      if (dot) {
        dot.title = item.unread ? "Unread" : "Read";
        dot.setAttribute("aria-label", dot.title);
      }
      if (isPriority) {
        const priority = computeItemPriority(current, item);
        const badge = node.querySelector(".gns-priority-badge");
        if (badge) {
          setText(badge, `${priority.tier} · ${priority.score}`);
          badge.dataset.tier = priority.tier;
          badge.title = priority.breakdown;
        }
      }
      updatePin(node.querySelector("[data-gns-pin]"), item, true);
      const review = node.querySelector(".gns-caught-up");
      const reviewedItem = caughtUp(current, item);
      node.dataset.caughtUp = String(reviewedItem);
      review.setAttribute("aria-pressed", String(reviewedItem));
      review.setAttribute("aria-label", `${reviewedItem ? "Undo caught up for" : "Mark caught up:"} ${item.label}`);
      review.disabled = !current.viewer || !current.reviewsReady || !storeApi.activityToken(item);
      review.title = !current.viewer ? "Signed-in username unavailable." :
        !current.reviewsReady ? "Local review state is not ready." :
          !storeApi.activityToken(item) ? "GitHub did not provide an update time; this item cannot be tracked safely." :
            reviewedItem ? "Undo caught up" : "Mark caught up (hides it here until new activity; GitHub is unchanged)";
    }
    const ordered = visible.map((item) => current.rendered.get(item.key));
    if (ordered.some((node, index) => current.list.children[index] !== node)) {
      const active = document.activeElement;
      current.list.append(...ordered);
      if (active && current.list.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
    }
    setText(current.showCaughtUpButton, `${current.showCaughtUp ? "Hide" : "Show"} caught up (${reviewed.length})`);
    current.showCaughtUpButton.setAttribute("aria-pressed", String(current.showCaughtUp));
    current.showCaughtUpButton.disabled = !current.viewer || !current.reviewsReady;
    current.undo.hidden = !current.undoItem || !caughtUp(current, current.undoItem);
    setText(current.reviewNote, !current.viewer ? "Signed-in username unavailable. Caught-up state and saved summaries are off." :
      !current.reviewsReady ? "Loading local review state..." :
        `${matches.length - reviewed.length} to review / ${reviewed.length} caught up. New activity returns after Refresh.`);
    current.localErrorNode.hidden = !current.localError;
    setText(current.localErrorNode, current.localError);
    if (moveFocus) (current.list.querySelector(".gns-result-link") || (current.undo.hidden ? current.menuButton : current.undo)).focus({ preventScroll: true });
    renderSummaryControls(current);

    const hasItems = ready && (isPriority || subscriptions.size > 0);
    const message = storageError || current.error;
    current.hiddenCaughtUpCount = reviewed.length;
    setText(current.title, isToday ? "Today" : isPriority ? "Priority" : filter.name);
    setText(current.count, ready ? String(visible.length) : "");
    current.count.hidden = !ready;
    current.count.title = reviewed.length && !current.showCaughtUp ?
      `${visible.length} visible (${reviewed.length} hidden as caught up; ${subscriptions.size} total saved in list)` :
      `${visible.length} matching ${visible.length === 1 ? "notification" : "notifications"}`;
    current.count.setAttribute("aria-label", current.count.title);
    for (const todayBadge of document.querySelectorAll("[data-gns-today-filter] .gns-count")) {
      if (isPriority && current.cacheLoaded) {
        const p1Visible = allPriorityMatches.filter((item) =>
          computeItemPriority(current, item).tier === "P1" && (current.showCaughtUp || !caughtUp(current, item))
        );
        setText(todayBadge, String(p1Visible.length));
      }
    }
    for (const priorityBadge of document.querySelectorAll("[data-gns-priority-filter] .gns-count")) {
      if (isPriority && current.cacheLoaded) {
        const prioVisible = allPriorityMatches.filter((item) => current.showCaughtUp || !caughtUp(current, item));
        setText(priorityBadge, String(prioVisible.length));
      }
    }
    if (!isPriority && current.cacheLoaded) {
      for (const subBadge of document.querySelectorAll("[data-gns-filter] .gns-count")) {
        setText(subBadge, String(visible.length));
        subBadge.title = `${visible.length} active inbox notifications (${subscriptions.size} saved in subscription list)`;
      }
    }
    const scanned = `${current.state.rowCount.toLocaleString()} notifications checked across ${current.state.pages} ${current.state.pages === 1 ? "page" : "pages"}`;
    const checked = current.checkedAt ? ` Last checked ${relativeTime(new Date(current.checkedAt).toISOString())}.` : "";
    const progress = !ready || !current.cacheLoaded ? "Loading saved subscriptions..." :
      !hasItems ? "Your list is local to this Chrome profile." :
      message ? `Search incomplete. ${scanned}.` :
      current.state.complete ? `Inbox search complete. ${scanned}.${checked}` :
      current.paused ? `Search paused. ${scanned}.` : `Searching your inbox... ${scanned}.`;
    setText(current.status, progress);
    current.errorNode.hidden = !message;
    setText(current.errorNode, message);
    current.pause.hidden = !hasItems || current.state.complete;
    current.pause.disabled = current.paused && current.state.running;
    setText(current.pause, current.state.running && !current.paused ? "Pause" : message ? "Retry" : "Continue");
    current.refresh.disabled = !ready;
    current.empty.hidden = visible.length > 0;
    current.add.hidden = !ready || hasItems;
    let emptyTitle = isToday ? "Loading Today's P1 briefing" : isPriority ? "Loading priority notifications" : "Loading subscriptions";
    let emptyText = isToday ? "Scanning your inbox for P1 notifications and preparing your morning executive briefing." :
      isPriority ? "Scanning your inbox for direct asks, leadership activity, and recent updates." : "Your saved list will appear here.";
    if (ready && !hasItems) {
      emptyTitle = "Choose what belongs here";
      emptyText = "Add issue, pull request, or discussion links. Only their inbox notifications will appear.";
    } else if (hasItems) {
      emptyTitle = message ? "The search needs attention" :
        current.state.complete ? (isToday ? "No P1 notifications today" : isPriority ? "No priority notifications right now" : "No matching inbox notifications") :
        current.paused ? "Search paused" : (isToday ? "Finding P1 notifications" : isPriority ? "Scoring your notifications" : "Looking for your subscriptions");
      emptyText = current.state.complete ?
        (isToday ? "None of your inbox notifications crossed the P1 threshold (score ≥ 70)." :
          isPriority ? "None of your inbox notifications crossed the Priority threshold (score ≥ 35)." :
          "None of the inbox notifications match your list. Completed notifications are still in GitHub's Done view.") :
        "Matches appear as pages are checked. You can leave this view or pause at any time.";
      if (reviewed.length && !visible.length) {
        emptyTitle = "You're caught up";
        emptyText = `${reviewed.length} matching ${reviewed.length === 1 ? "notification is" : "notifications are"} hidden locally. Show caught up to revisit them, or refresh to check for new activity.`;
      }
    }
    setText(current.emptyTitle, emptyTitle);
    setText(current.emptyText, emptyText);
    const count = current.state.unidentified;
    current.unidentified.hidden = !count;
    setText(current.unidentified, count ? `${count} ${count === 1 ? "notification had an unsupported or unrecognized item link and was" : "notifications had unsupported or unrecognized item links and were"} not shown.` : "");
    if (current.sweepBar) {
      const buckets = { "review-requested": 0, "team-mention": 0, "stale-participating": 0 };
      for (const item of current.items.values()) {
        const info = classifyItemSweep(current, item);
        if (info.sweepable && Object.hasOwn(buckets, info.bucket)) buckets[info.bucket] += 1;
      }
      const totalSweep = buckets["review-requested"] + buckets["team-mention"] + buckets["stale-participating"];
      current.sweepBar.hidden = !ready || (totalSweep === 0 && !current.sweepMessage);
      current.sweepReview.hidden = buckets["review-requested"] === 0;
      current.sweepReview.disabled = current.sweeping || buckets["review-requested"] === 0;
      setText(current.sweepReview, `Review requested (${buckets["review-requested"]})`);
      current.sweepTeam.hidden = buckets["team-mention"] === 0;
      current.sweepTeam.disabled = current.sweeping || buckets["team-mention"] === 0;
      setText(current.sweepTeam, `Team mentioned (${buckets["team-mention"]})`);
      current.sweepParticipating.hidden = buckets["stale-participating"] === 0;
      current.sweepParticipating.disabled = current.sweeping || buckets["stale-participating"] === 0;
      setText(current.sweepParticipating, `Stale participating (${buckets["stale-participating"]})`);
      current.sweepAll.hidden = totalSweep === 0;
      current.sweepAll.disabled = current.sweeping || totalSweep === 0;
      setText(current.sweepAll, `Sweep all noise (${totalSweep})`);
      setText(current.sweepStatus, current.sweepMessage);
    }
    renderLive(current);
    if (isToday) {
      void updateTodayBriefing(current);
    }
    if (isPriority && current.state.complete && !current.kevOffline && !current.kevRefining && !current.kevDone && current.items.size > 0) {
      void refinePriorityWithKev(current);
    }
  }

  async function loadPage(current, url, signal) {
    if (current.useDocument && url === INBOX) {
      current.useDocument = false;
      return dom.readPage(document, url);
    }
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "text/html" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error("GitHub rate-limited this search. Wait a minute, then choose Retry.");
      throw new Error(`GitHub could not load a notification page (HTTP ${response.status}). Check your sign-in, then choose Retry.`);
    }
    if (!response.headers.get("content-type")?.includes("text/html")) {
      throw new Error("GitHub did not return a notifications page. The search is incomplete.");
    }
    const html = await response.text();
    signal.throwIfAborted();
    return dom.readPage(new DOMParser().parseFromString(html, "text/html"), url);
  }

  function scanCacheKey(current) {
    return current.viewer ? `${SCAN_CACHE_PREFIX}${current.viewer}` : "";
  }

  function mergeItem(items, item, replace = false) {
    const previous = items.get(item.key);
    if (replace || !previous || (item.dateTime && (!previous.dateTime || Date.parse(item.dateTime) > Date.parse(previous.dateTime)))) {
      items.set(item.key, item);
    }
  }

  function validCachedItem(item) {
    return item && typeof item.key === "string" && typeof item.title === "string" && typeof item.label === "string" &&
      typeof item.href === "string" && core.parseItem(item.href)?.key === item.key && Array.isArray(item.participants);
  }

  async function loadScanCache(current, fresh) {
    let cached = null;
    const key = scanCacheKey(current);
    try {
      if (key && chrome.storage.session) cached = (await chrome.storage.session.get(key))[key];
    } catch {
      cached = null;
    }
    if (view !== current) return;
    current.cacheLoaded = true;
    if (cached && Array.isArray(cached.items) && Number.isFinite(cached.checkedAt) && cached.items.every(validCachedItem)) {
      for (const item of cached.items) current.items.set(item.key, item);
      current.checkedAt = cached.checkedAt;
      if (!fresh && isFreshScanCache(current, cached.checkedAt)) {
        Object.assign(current.state, {
          next: null, pending: [], complete: true,
          pages: cached.pages | 0, rowCount: cached.rowCount | 0, unidentified: cached.unidentified | 0
        });
        current.fromCache = true;
        if (cached.authors && typeof cached.authors === "object") {
          current.authors = new Map(Object.entries(cached.authors));
        }
        if (cached.responses && typeof cached.responses === "object") {
          current.responses = new Map(Object.entries(cached.responses));
        }
        if (cached.kevScores && typeof cached.kevScores === "object") {
          current.kevScores = new Map(Object.entries(cached.kevScores));
        }
        if (typeof cached.kevDone === "boolean") {
          current.kevDone = cached.kevDone;
        }
        if (Array.isArray(cached.priorityOrder) && cached.prioritySnapshot && typeof cached.prioritySnapshot === "object") {
          current.priorityOrder = cached.priorityOrder.filter((itemKey) => current.items.has(itemKey));
          current.prioritySnapshot = new Map(Object.entries(cached.prioritySnapshot));
        }
        if (current.useDocument) {
          current.useDocument = false;
          try {
            for (const item of dom.readPage(document, INBOX).items) {
              if ((current.mode === "priority" || current.mode === "today") && current.priorityOrder?.length && current.items.has(item.key)) {
                // Preserve the pinned item's priority snapshot while updating read/unread dot state.
                current.items.set(item.key, { ...current.items.get(item.key), unread: item.unread });
              } else {
                mergeItem(current.items, item, true);
              }
            }
          } catch {
            // The cached result is still usable when the current page cannot be read.
          }
        }
        if ((current.mode === "priority" || current.mode === "today") && !current.priorityOrder?.length) {
          lockPrioritySnapshot(current);
          saveScanCache(current);
        }
      }
    }
    ensureView(false, current.mode);
  }

  function saveScanCache(current) {
    const key = scanCacheKey(current);
    if (!key || !chrome.storage.session) return;
    if (current.state.complete && !current.priorityOrder?.length) {
      lockPrioritySnapshot(current);
    }
    const { pages, rowCount, unidentified } = current.state;
    chrome.storage.session.set({
      [key]: {
        checkedAt: current.checkedAt,
        items: [...current.items.values()],
        pages,
        rowCount,
        unidentified,
        authors: current.authors ? Object.fromEntries(current.authors) : {},
        responses: current.responses ? Object.fromEntries(current.responses) : {},
        kevScores: current.kevScores ? Object.fromEntries(current.kevScores) : {},
        kevDone: Boolean(current.kevDone),
        priorityOrder: current.priorityOrder || null,
        prioritySnapshot: current.prioritySnapshot ? Object.fromEntries(current.prioritySnapshot) : null
      }
    }).catch(() => {});
  }

  async function runView(current) {
    const canScan = current.mode === "priority" || current.mode === "today" || subscriptions.size > 0;
    if (view !== current || !current.cacheLoaded || current.state.running || !ready || !canScan || current.state.complete) return;
    current.started = true;
    current.paused = false;
    current.error = "";
    current.controller = new AbortController();
    const signal = current.controller.signal;
    const scanPromise = scanner.scan(current.state, {
      signal,
      loadPage: (url, pageSignal) => loadPage(current, url, pageSignal),
      onPage: (page) => {
        if (view !== current) return;
        for (const item of page.items) {
          mergeItem(current.scanned, item);
          current.items.set(item.key, current.scanned.get(item.key));
        }
        if (current.state.complete) {
          current.items = new Map(current.scanned);
          current.checkedAt = Date.now();
          current.fromCache = false;
          saveScanCache(current);
        }
        renderView(current);
      }
    });
    renderView(current);
    try {
      await scanPromise;
    } catch (error) {
      if (!signal.aborted) {
        current.error = error.name === "TimeoutError" ? "GitHub took too long to respond. Choose Retry to keep searching." :
          error instanceof TypeError ? "A GitHub page could not be loaded. Check your connection and sign-in, then choose Retry." :
          errorText(error);
      }
    } finally {
      renderView(current);
      if (view === current && current.pausedByEmpty && subscriptions.size) {
        current.pausedByEmpty = false;
        void runView(current);
      }
    }
  }

  function ensureView(fresh = false, mode = core.isTodayView?.(location.href) ? "today" :
      core.isPriorityView(location.href) ? "priority" : "subscriptions") {
    const root = dom.nativeRoot(document);
    const signature = mode + "|" + location.pathname + location.search + "|" + signedInLogin();
    if (view && (!view.panel.isConnected || view.nativeRoot !== root || view.signature !== signature)) stopView();
    if (!view) {
      view = makeView(root, mode);
      void loadReviews(view);
      if (fresh) view.useDocument = false;
      void loadScanCache(view, fresh);
    }
    hideNative(root);
    const canScan = view.mode === "priority" || view.mode === "today" || subscriptions.size > 0;
    if (!canScan && view.state.running) {
      view.paused = true;
      view.pausedByEmpty = true;
      view.controller.abort();
    }
    renderView(view);
    if (ready && canScan && (!view.started || view.pausedByEmpty)) {
      if (!view.state.running) view.pausedByEmpty = false;
      void runView(view);
    }
  }

  function stopView() {
    if (view) {
      const previous = view;
      view = null;
      previous.controller?.abort();
      previous.briefingRequest?.abort();
      previous.previewController.abort();
      previous.listeners.abort();
      previous.summaryQueue.length = 0;
      previous.panel.remove();
    }
    restoreNative();
  }

  function stopNativeView() {
    if (nativeView) {
      const previous = nativeView;
      nativeView = null;
      previous.previewController.abort();
      previous.listeners.abort();
      previous.summaryQueue.length = 0;
      for (const tools of previous.commentTools.values()) tools.cancel();
      previous.commentTools.clear();
      previous.rowEntries.clear();
      previous.toolbar.remove();
    }
    for (const node of document.querySelectorAll("[data-gns-row-inline], [data-gns-row-activity], [data-gns-row-details]")) node.remove();
    for (const grid of document.querySelectorAll(".gns-native-row-grid")) grid.classList.remove("gns-native-row-grid");
    for (const row of document.querySelectorAll("[data-gns-row-expanded], [data-gns-has-summary], [data-gns-nested-row]")) {
      delete row.dataset.gnsRowExpanded;
      delete row.dataset.gnsHasSummary;
      delete row.dataset.gnsNestedRow;
    }
  }

  function ensureNativeView() {
    const root = dom.nativeRoot(document);
    const signature = location.pathname + location.search + "|" + signedInLogin();
    if (nativeView && nativeView.signature !== signature) {
      stopNativeView();
    } else if (nativeView) {
      nativeView.nativeRoot = root;
    }
    if (!nativeView) {
      nativeView = makeNativeView(root);
      void loadReviews(nativeView);
    }
    const header = root?.querySelector(".Box-header") || document.querySelector(".js-check-all-container > .Box > .Box-header, .Box-header");
    if (header) {
      nativeView.toolbar.dataset.standalone = "false";
      if (nativeView.toolbar.parentElement !== header) header.append(nativeView.toolbar);
    } else if (root) {
      nativeView.toolbar.dataset.standalone = "true";
      if (nativeView.toolbar.parentElement !== root) root.prepend(nativeView.toolbar);
    }
    decorateRows(nativeView);
    renderSummaryControls(nativeView);
  }

  function reconcile() {
    const notifications = core.isNotifications(location.href);
    const activeMode = core.isTodayView?.(location.href) ? "today" :
      core.isPriorityView(location.href) ? "priority" :
      core.isSubscriptionView(location.href) ? "subscriptions" : "";
    if (notifications) {
      document.querySelector("[data-gns-item-tools]")?.remove();
      ensureSidebar(activeMode);
      decorateFilterForms();
      if (activeMode) {
        stopNativeView();
        ensureView(false, activeMode);
      } else {
        stopView();
        ensureNativeView();
      }
    } else {
      stopView();
      stopNativeView();
      restoreSelection();
      for (const link of document.querySelectorAll("[data-gns-filter], [data-gns-priority-filter], [data-gns-today-filter]")) {
        (link.closest(".gns-sidebar-item") || link).remove();
      }
      document.querySelector(".gns-filter-group")?.remove();
      decorateItemPage();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      reconcile();
    }, 80);
  }

  const observer = new MutationObserver((records) => {
    let mutatedNativeList = false;
    let relevant = false;
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest("[data-gns-owned]")) continue;
      if (record.type !== "childList") {
        relevant = true;
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node instanceof Element && !node.hasAttribute("data-gns-owned")) {
          relevant = true;
          if (node.matches?.(dom.ROW_SELECTOR) || node.querySelector?.(dom.ROW_SELECTOR) ||
              node.matches?.(dom.ROOT_SELECTOR) || node.querySelector?.(dom.ROOT_SELECTOR)) {
            mutatedNativeList = true;
          }
        } else if (!(node instanceof Element)) {
          relevant = true;
        }
      }
    }
    if (mutatedNativeList && nativeView) {
      reconcile();
    } else if (relevant) {
      schedule();
    }
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-notification-id", "content", "datetime"]
  });
  for (const name of ["turbo:load", "turbo:render", "pjax:end"]) document.addEventListener(name, schedule);
  for (const name of ["popstate", "hashchange", "pageshow"]) window.addEventListener(name, schedule);
  document.addEventListener("turbo:before-cache", () => {
    stopView();
    stopNativeView();
    restoreSelection();
    for (const node of document.querySelectorAll("[data-gns-owned]")) node.remove();
  });
  window.addEventListener("pagehide", () => {
    stopView();
    stopNativeView();
  });
  window.addEventListener("submit", interceptFilterSubmit, true);
  window.addEventListener("click", interceptFilterSubmit, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (storeApi.isSubscriptionChange(changes, area) || storeApi.isFilterChange(changes, area) ||
        storeApi.isPriorityRulesChange?.(changes, area)) {
      if (view && storeApi.isPriorityRulesChange?.(changes, area)) {
        view.priorityOrder = null;
        view.prioritySnapshot = null;
      }
      void loadSubscriptions();
    }
    if (storeApi.isSummaryChange(changes, area)) void loadSummarySettings();
    for (const current of [view, nativeView]) {
      if (!current) continue;
      if (storeApi.isReviewChange(changes, area)) void loadReviews(current);
      if (storeApi.isCacheChange(changes, area)) {
        if (Object.hasOwn(changes, storeApi.CACHE_RESET_KEY)) stopSummaries(current);
        for (const tools of current.commentTools.values()) tools.cacheChanged(changes);
      }
    }
  });
  void preloadMemorySummaries();
  reconcile();
  void loadSummarySettings();
  void loadSubscriptions();
})();
