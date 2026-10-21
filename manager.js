(function startManager() {
  "use strict";

  if (typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.name === "GitHub Notification Subscriptions") {
    chrome.runtime.reload();
    return;
  }

  const core = globalThis.GitHubSubscriptions;
  const summary = globalThis.GitHubSubscriptionSummary;
  const summaryClient = globalThis.GitHubSubscriptionSummaryClient;
  const storeApi = globalThis.GitHubSubscriptionStore;
  const store = storeApi.createStore(chrome.storage.local);
  const popup = new URLSearchParams(location.search).has("popup");
  if (popup) document.documentElement.setAttribute("data-popup", "");
  const byId = (id) => document.getElementById(id);
  let items = [];
  let currentItem = null;
  let loaded = false;
  let loadVersion = 0;
  let summarySettings = { ...summary.DEFAULT_SETTINGS };
  let summaryLoaded = false;
  let summaryDirty = false;
  let summaryBusy = false;
  let modelList = null;
  let summaryLoadVersion = 0;
  const summaryController = new AbortController();

  function showError(error) {
    byId("error").textContent = core.cleanText(error.message, 600);
    byId("error").hidden = false;
    byId("status").textContent = "";
  }

  function clearError() {
    byId("error").hidden = true;
    byId("error").textContent = "";
    byId("links").removeAttribute("aria-invalid");
  }

  function render() {
    const query = byId("search").value.trim().toLowerCase();
    const matches = items.filter((item) => `${item.label} ${core.TYPE_LABELS[item.type]}`.toLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    const focused = document.activeElement;
    const focusedKey = focused?.dataset.key;
    const focusSelector = focused?.tagName === "A" ? "a[data-key]" : "button[data-key]";
    const oldIndex = [...byId("saved-list").querySelectorAll(focusSelector)].indexOf(focused);
    for (const item of matches) {
      const li = document.createElement("li");
      li.className = "saved-item";
      const content = document.createElement("div");
      const link = document.createElement("a");
      link.href = item.url;
      link.textContent = item.label;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.key = item.key;
      const type = document.createElement("span");
      type.className = "item-type";
      type.textContent = core.TYPE_LABELS[item.type];
      content.append(link, type);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-button";
      remove.textContent = "Remove";
      remove.dataset.key = item.key;
      remove.disabled = !loaded;
      remove.setAttribute("aria-label", `Remove ${item.label} from subscriptions`);
      li.append(content, remove);
      fragment.append(li);
    }
    byId("saved-list").replaceChildren(fragment);
    byId("saved-count").textContent = String(items.length);
    byId("empty").hidden = !loaded || items.length > 0;
    byId("no-results").hidden = !loaded || items.length === 0 || matches.length > 0;
    byId("search").hidden = items.length === 0;
    byId("export").disabled = !loaded || items.length === 0;
    byId("add-button").disabled = !loaded;
    if (currentItem) {
      const saved = items.some((item) => item.key === currentItem.key);
      byId("save-current").textContent = saved ? "Already saved" : "Add this page";
      byId("save-current").disabled = !loaded || saved;
    }
    if (focusedKey) {
      const controls = [...byId("saved-list").querySelectorAll(focusSelector)];
      const next = controls.find((node) => node.dataset.key === focusedKey) ||
        controls[Math.min(Math.max(oldIndex, 0), controls.length - 1)] || byId("links");
      next.focus({ preventScroll: true });
    }
  }

  async function load() {
    const version = ++loadVersion;
    try {
      const saved = await store.list();
      if (version !== loadVersion) return;
      items = saved;
      loaded = true;
      render();
      if (byId("status").textContent === "Loading your list...") byId("status").textContent = "";
    } catch (error) {
      if (version !== loadVersion) return;
      loaded = false;
      render();
      throw error;
    }
  }

  byId("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();
    if (!loaded) {
      showError(new Error("Your saved list is not available. Refresh the extension before adding items."));
      return;
    }
    const parsed = core.parseInput(byId("links").value);
    if (!parsed.items.length && !parsed.invalid.length) {
      showError(new Error("Paste at least one GitHub link."));
      byId("links").focus();
      return;
    }
    if (parsed.invalid.length) {
      byId("links").setAttribute("aria-invalid", "true");
      const examples = parsed.invalid.slice(0, 3).join(", ");
      showError(new Error(`Nothing was added. Check ${parsed.invalid.length === 1 ? "this entry" : "these entries"}: ${examples}. Use item links on github.com, one per line. Commit links need the full 40-character SHA.`));
      byId("links").focus();
      return;
    }
    byId("add-button").disabled = true;
    try {
      const added = await store.add(parsed.items);
      await load();
      byId("links").value = "";
      byId("status").textContent = added ? `Added ${added} ${added === 1 ? "subscription" : "subscriptions"}.` : "Those items are already on your list.";
    } catch (error) {
      showError(error);
    } finally {
      byId("add-button").disabled = !loaded;
    }
  });

  byId("saved-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-key]");
    if (!button) return;
    const item = items.find((candidate) => candidate.key === button.dataset.key);
    if (!item) {
      showError(new Error("That item changed in another tab. Refresh the list and try again."));
      return;
    }
    clearError();
    button.disabled = true;
    try {
      await store.remove(item);
      await load();
      byId("status").textContent = `Removed ${item.label}.`;
    } catch (error) {
      button.disabled = false;
      showError(error);
    }
  });

  byId("search").addEventListener("input", render);
  byId("links").addEventListener("input", clearError);

  byId("save-current").addEventListener("click", async () => {
    if (!currentItem) return;
    clearError();
    byId("save-current").disabled = true;
    try {
      await store.add([currentItem]);
      await load();
      byId("status").textContent = `Added ${currentItem.label}.`;
    } catch (error) {
      byId("save-current").disabled = false;
      showError(error);
    }
  });

  byId("export").addEventListener("click", () => {
    const blob = new Blob([items.map((item) => item.url).join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "github-subscriptions.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    byId("status").textContent = "Exported links. Paste them into Add GitHub links to restore them later.";
  });

  byId("open-manager").hidden = !popup;
  byId("open-manager").addEventListener("click", async () => {
    try {
      await chrome.runtime.openOptionsPage();
      if (popup) window.close();
    } catch (error) {
      showError(error);
    }
  });

  async function readCurrentPage() {
    if (!popup) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentItem = core.parseItem(tab?.url);
      if (!currentItem) return;
      byId("current-label").textContent = currentItem.label;
      byId("current-page").hidden = false;
      render();
    } catch (error) {
      showError(error);
    }
  }

  function summaryError(error) {
    byId("summary-error").textContent = core.cleanText(error.message, 600);
    byId("summary-error").hidden = false;
    byId("summary-status").textContent = "";
  }

  function clearSummaryError() {
    byId("summary-error").hidden = true;
    byId("summary-error").textContent = "";
  }

  function summaryControls() {
    byId("connect-models").disabled = summaryBusy || !summaryLoaded;
    byId("summary-model").disabled = summaryBusy || !summaryLoaded || (!modelList && !summarySettings.model);
    byId("summary-server").disabled = summaryBusy || !summaryLoaded;
    byId("summary-automatic").disabled = summaryBusy || !summaryLoaded;
    byId("save-summary-settings").disabled = summaryBusy || !summaryLoaded || !byId("summary-model").value;
    byId("disable-summaries").hidden = !summarySettings.model && summaryLoaded;
    byId("disable-summaries").textContent = summaryLoaded ? "Turn off summaries" : "Reset AI settings";
    byId("disable-summaries").disabled = summaryBusy;
  }

  function modelOptions(selected) {
    const select = byId("summary-model");
    select.replaceChildren(new Option(modelList ? "Choose an installed local model" : "Connect to list installed models", ""));
    for (const model of modelList || []) select.add(new Option(model.id, model.id));
    if (selected && !modelList?.some((model) => model.id === selected)) {
      select.add(new Option(modelList ? `${selected} (not currently available)` : selected, selected));
    }
    select.value = selected;
    summaryControls();
  }

  async function loadSummarySettings() {
    const version = ++summaryLoadVersion;
    try {
      const saved = await store.getSummarySettings();
      if (version !== summaryLoadVersion) return;
      summarySettings = saved;
      summaryLoaded = true;
      if (!summaryDirty) {
        if (saved.model) byId("summary-server").value = summary.providerForModel(saved.model);
        modelOptions(saved.model);
        byId("summary-automatic").checked = saved.automatic;
      }
      summaryControls();
    } catch (error) {
      if (version !== summaryLoadVersion) return;
      summaryLoaded = false;
      summaryError(error);
      summaryControls();
    }
  }

  byId("connect-models").addEventListener("click", async () => {
    clearSummaryError();
    summaryBusy = true;
    summaryControls();
    byId("summary-status").textContent = "Checking installed models on this Mac...";
    try {
      modelList = await summaryClient.request({ type: "models", provider: byId("summary-server").value }, { signal: summaryController.signal });
      const selected = byId("summary-model").value || summary.recommendedModel(modelList);
      modelOptions(selected);
      byId("summary-status").textContent = modelList.length ?
        "Connected. Choose a model and save your settings." :
        "The server is running, but no supported local text models are installed. Install one in that app, then connect again.";
      summaryDirty = true;
    } catch (error) {
      if (!summaryController.signal.aborted) summaryError(error);
    } finally {
      summaryBusy = false;
      summaryControls();
    }
  });

  byId("summary-server").addEventListener("change", () => {
    modelList = null;
    summaryDirty = true;
    modelOptions("");
    clearSummaryError();
    byId("summary-status").textContent = "Connect to list models on the selected local server.";
  });

  byId("summary-form").addEventListener("input", () => {
    summaryDirty = true;
    clearSummaryError();
    summaryControls();
  });
  byId("summary-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearSummaryError();
    summaryBusy = true;
    summaryControls();
    try {
      const model = byId("summary-model").value;
      if (!model || (modelList && !modelList.some((entry) => entry.id === model))) {
        throw new Error("Connect to your local server and choose an available model before saving.");
      }
      const provider = summary.providerForModel(model);
      if (!["ollama", "lmstudio", "mlx", "splash"].includes(provider)) {
        throw new Error("Unsupported provider. Choose Splash, Ollama, LM Studio, or MLX.");
      }
      summarySettings = await store.saveSummarySettings({
        model, automatic: byId("summary-automatic").checked
      });
      summaryDirty = false;
      byId("summary-status").textContent = summarySettings.automatic ?
        "Saved. Linked comments will be summarized when you open a notifications view." :
        "Saved. Use Summarize comments in any notifications filter view.";
    } catch (error) {
      summaryError(error);
    } finally {
      summaryBusy = false;
      summaryControls();
    }
  });
  byId("disable-summaries").addEventListener("click", async () => {
    clearSummaryError();
    summaryBusy = true;
    summaryControls();
    try {
      summarySettings = await store.saveSummarySettings({ ...summary.DEFAULT_SETTINGS });
      summaryLoaded = true;
      summaryDirty = false;
      modelOptions("");
      byId("summary-automatic").checked = false;
      byId("summary-status").textContent = "Summaries are off. Your subscriptions are unchanged.";
    } catch (error) {
      summaryError(error);
    } finally {
      summaryBusy = false;
      summaryControls();
    }
  });
  window.addEventListener("pagehide", () => summaryController.abort());

  function localDataError(error) {
    byId("local-data-error").hidden = false;
    byId("local-data-error").textContent = core.cleanText(error.message, 600);
  }

  async function loadLocalDataCounts() {
    const counts = await store.localDataCounts();
    byId("local-data-counts").textContent =
      `${counts.summaries} saved summaries / ${counts.reviews} caught-up markers.`;
  }

  let priorityRulesDirty = false;
  async function loadPriorityRules() {
    const field = byId("priority-rules-json");
    if (!field || !store.getPriorityRules) return;
    try {
      const rules = await store.getPriorityRules();
      const hasRules = Object.keys(rules.contacts || {}).length > 0 ||
        (rules.coreRepos?.length || 0) > 0 || (rules.adjacentRepos?.length || 0) > 0;
      let effective = rules;
      if (!hasRules) {
        const fallback = await chrome.runtime.sendMessage({ type: "gns:get-local-priority-rules" }).catch(() => null);
        if (fallback?.ok && fallback.value) effective = fallback.value;
      }
      const hasEffective = Object.keys(effective.contacts || {}).length > 0 ||
        (effective.coreRepos?.length || 0) > 0 || (effective.adjacentRepos?.length || 0) > 0;
      if (!priorityRulesDirty) {
        field.value = hasEffective ? JSON.stringify(effective, null, 2) : "";
      }
    } catch (error) {
      byId("priority-rules-error").hidden = false;
      byId("priority-rules-error").textContent = core.cleanText(error.message, 600);
    }
  }

  byId("priority-rules-json")?.addEventListener("input", () => {
    priorityRulesDirty = true;
    byId("priority-rules-error").hidden = true;
    byId("priority-rules-status").textContent = "";
  });

  byId("priority-rules-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    byId("priority-rules-error").hidden = true;
    byId("priority-rules-status").textContent = "";
    const raw = byId("priority-rules-json").value.trim();
    try {
      const parsed = raw ? JSON.parse(raw) : { contacts: {}, coreRepos: [], adjacentRepos: [] };
      const saved = await store.savePriorityRules(parsed);
      priorityRulesDirty = false;
      const contactCount = Object.keys(saved.contacts).length;
      const repoCount = saved.coreRepos.length + saved.adjacentRepos.length;
      byId("priority-rules-status").textContent = contactCount || repoCount ?
        `Saved ${contactCount} priority contacts and ${repoCount} repositories.` :
        "Cleared custom priority rules.";
    } catch (error) {
      byId("priority-rules-error").hidden = false;
      byId("priority-rules-error").textContent = core.cleanText(error.message, 600);
    }
  });

  for (const [id, kind] of [["clear-summary-cache", "summaries"], ["clear-review-state", "reviews"]]) {
    byId(id).addEventListener("click", async () => {
      byId(id).disabled = true;
      byId("local-data-error").hidden = true;
      byId("local-data-status").textContent = "";
      try {
        const result = await chrome.runtime.sendMessage({ type: "gns:clear-local-data", kind });
        if (!result?.ok) throw new Error(result?.error || "Local data could not be cleared. Reload the extension and retry.");
        await loadLocalDataCounts();
        byId("local-data-status").textContent = kind === "summaries" ?
          "Saved summaries cleared. Running summaries were stopped; request new ones when ready." :
          "Caught-up state reset. Matching notifications are visible again.";
      } catch (error) {
        localDataError(error);
      } finally {
        byId(id).disabled = false;
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (storeApi.isSubscriptionChange(changes, area)) void load().catch(showError);
    if (storeApi.isPriorityRulesChange?.(changes, area)) void loadPriorityRules();
    if (storeApi.isSummaryChange(changes, area)) void loadSummarySettings();
    if (storeApi.isCacheChange(changes, area) || storeApi.isReviewChange(changes, area)) {
      void loadLocalDataCounts().catch(localDataError);
    }
  });
  void load().catch(showError);
  void loadPriorityRules();
  void loadSummarySettings();
  void readCurrentPage();
  void loadLocalDataCounts().catch(localDataError);
})();
