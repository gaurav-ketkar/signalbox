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
  let providerCredentials = {};
  let summaryLoaded = false;
  let summaryDirty = false;
  let summaryBusy = false;
  let modelList = null;
  let briefingModelList = null;
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

  const API_KEY_HELP = {
    copilot: {
      label: "GitHub Copilot token (gh auth token)",
      placeholder: "gho_... (run `gh auth token | pbcopy` in Terminal)",
      help: "Run `gh auth token | pbcopy` in Terminal and paste that gho_... token here (web-UI fine-grained PATs are not accepted by api.githubcopilot.com)."
    },
    openai: {
      label: "OpenAI API key",
      placeholder: "sk-...",
      help: "Paste your OpenAI API key. Stored only in this Chrome profile."
    },
    anthropic: {
      label: "Anthropic API key",
      placeholder: "sk-ant-...",
      help: "Paste your Anthropic API key. Stored only in this Chrome profile."
    },
    gemini: {
      label: "Google Gemini API key",
      placeholder: "AIza...",
      help: "Paste your Google AI Studio API key. Stored only in this Chrome profile."
    }
  };

  function updateProviderInputs() {
    const provider = byId("summary-server").value;
    const isCloud = summary.isCloudProvider ? summary.isCloudProvider(provider) : false;
    const keyGroup = byId("summary-api-key-group");
    if (keyGroup) {
      keyGroup.hidden = !isCloud;
      if (isCloud && API_KEY_HELP[provider]) {
        byId("summary-api-key-label").textContent = API_KEY_HELP[provider].label;
        byId("summary-api-key").placeholder = API_KEY_HELP[provider].placeholder;
        byId("summary-api-key-help").textContent = API_KEY_HELP[provider].help;
        if (byId("summary-api-key").dataset.provider !== provider) {
          byId("summary-api-key").value = providerCredentials[provider] || "";
          byId("summary-api-key").dataset.provider = provider;
        }
      }
    }
    byId("connect-models").textContent = isCloud ? "Connect to cloud provider" : "Connect to local server";

    const briefingProvider = byId("briefing-server")?.value || "";
    const briefingOverride = byId("briefing-override-controls");
    if (briefingOverride) {
      briefingOverride.hidden = !briefingProvider;
      const briefingCloud = summary.isCloudProvider ? summary.isCloudProvider(briefingProvider) : false;
      const briefingKeyGroup = byId("briefing-api-key-group");
      if (briefingKeyGroup) {
        briefingKeyGroup.hidden = !briefingCloud || briefingProvider === provider;
        if (briefingCloud && API_KEY_HELP[briefingProvider]) {
          byId("briefing-api-key-label").textContent = `${API_KEY_HELP[briefingProvider].label} (for Today briefing)`;
          byId("briefing-api-key").placeholder = API_KEY_HELP[briefingProvider].placeholder;
          if (byId("briefing-api-key").dataset.provider !== briefingProvider) {
            byId("briefing-api-key").value = providerCredentials[briefingProvider] || "";
            byId("briefing-api-key").dataset.provider = briefingProvider;
          }
        }
      }
    }
  }

  async function ensureProviderPermission(provider) {
    if (!summary.isCloudProvider?.(provider)) return;
    const origin = summary.permissionOriginForProvider(provider);
    try {
      const req = chrome.permissions?.request?.({ origins: [origin] });
      if (navigator.webdriver) {
        await Promise.race([req, new Promise((resolve) => setTimeout(resolve, 150))]);
      } else {
        await req;
      }
    } catch {
      // Background worker verifies chrome.permissions.contains before making any request.
    }
  }

  function summaryControls() {
    updateProviderInputs();
    byId("connect-models").disabled = summaryBusy || !summaryLoaded;
    byId("summary-model").disabled = summaryBusy || !summaryLoaded || (!modelList && !summarySettings.model);
    byId("summary-server").disabled = summaryBusy || !summaryLoaded;
    const manualOnly = Boolean(byId("summary-manual-only")?.checked);
    byId("summary-automatic").disabled = summaryBusy || !summaryLoaded || manualOnly;
    if (manualOnly) byId("summary-automatic").checked = false;
    if (byId("summary-manual-only")) byId("summary-manual-only").disabled = summaryBusy || !summaryLoaded;
    if (byId("briefing-server")) byId("briefing-server").disabled = summaryBusy || !summaryLoaded;
    if (byId("connect-briefing-models")) byId("connect-briefing-models").disabled = summaryBusy || !summaryLoaded;
    if (byId("briefing-model")) {
      byId("briefing-model").disabled = summaryBusy || !summaryLoaded ||
        (!briefingModelList && !summarySettings.briefingModel);
    }
    const briefingNeedModel = Boolean(byId("briefing-server")?.value && !byId("briefing-model")?.value);
    byId("save-summary-settings").disabled = summaryBusy || !summaryLoaded || !byId("summary-model").value || briefingNeedModel;
    byId("disable-summaries").hidden = !summarySettings.model && summaryLoaded;
    byId("disable-summaries").textContent = summaryLoaded ? "Turn off summaries" : "Reset AI settings";
    byId("disable-summaries").disabled = summaryBusy;
  }

  function modelOptions(selected) {
    const select = byId("summary-model");
    select.replaceChildren(new Option(modelList ? "Choose an available model" : "Connect to list installed models", ""));
    for (const model of modelList || []) select.add(new Option(model.id, model.id));
    if (selected && !modelList?.some((model) => model.id === selected)) {
      select.add(new Option(modelList ? `${selected} (not currently available)` : selected, selected));
    }
    select.value = selected;
    summaryControls();
  }

  function briefingModelOptions(selected) {
    const select = byId("briefing-model");
    if (!select) return;
    select.replaceChildren(new Option(briefingModelList ? "Choose a Today briefing model" : "Connect to list available models", ""));
    for (const model of briefingModelList || []) select.add(new Option(model.id, model.id));
    if (selected && !briefingModelList?.some((model) => model.id === selected)) {
      select.add(new Option(briefingModelList ? `${selected} (not currently available)` : selected, selected));
    }
    select.value = selected;
    summaryControls();
  }

  async function loadSummarySettings() {
    const version = ++summaryLoadVersion;
    try {
      const [saved, creds] = await Promise.all([
        store.getSummarySettings(),
        store.getProviderCredentials ? store.getProviderCredentials() : Promise.resolve({})
      ]);
      if (version !== summaryLoadVersion) return;
      summarySettings = saved;
      providerCredentials = creds || {};
      summaryLoaded = true;
      if (!summaryDirty) {
        if (saved.model) byId("summary-server").value = summary.providerForModel(saved.model);
        modelOptions(saved.model);
        byId("summary-automatic").checked = Boolean(saved.automatic && !saved.manualOnly);
        if (byId("summary-manual-only")) byId("summary-manual-only").checked = Boolean(saved.manualOnly);
        if (byId("briefing-server")) {
          byId("briefing-server").value = saved.briefingModel ? summary.providerForModel(saved.briefingModel) : "";
          briefingModelOptions(saved.briefingModel || "");
        }
      }
      summaryControls();
    } catch (error) {
      if (version !== summaryLoadVersion) return;
      summaryLoaded = false;
      summaryError(error);
      summaryControls();
    }
  }

  byId("summary-api-key")?.addEventListener("input", () => {
    byId("summary-api-key").dataset.edited = "true";
    summaryDirty = true;
    clearSummaryError();
  });

  byId("briefing-api-key")?.addEventListener("input", () => {
    byId("briefing-api-key").dataset.edited = "true";
    summaryDirty = true;
    clearSummaryError();
  });

  byId("connect-models").addEventListener("click", async () => {
    clearSummaryError();
    summaryBusy = true;
    summaryControls();
    const provider = byId("summary-server").value;
    const isCloud = summary.isCloudProvider ? summary.isCloudProvider(provider) : false;
    byId("summary-status").textContent = isCloud ?
      `Connecting to ${summary.serverLabelForProvider(provider)}...` :
      "Checking installed models on this Mac...";
    try {
      await ensureProviderPermission(provider);
      let apiKey = "";
      if (isCloud) {
        apiKey = (byId("summary-api-key")?.value || providerCredentials[provider] || "").trim();
        if (store.saveProviderCredential && apiKey) {
          providerCredentials = await store.saveProviderCredential(provider, apiKey);
        }
      }
      modelList = await summaryClient.request(
        isCloud ? { type: "models", provider, apiKey } : { type: "models", provider },
        { signal: summaryController.signal }
      );
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

  byId("connect-briefing-models")?.addEventListener("click", async () => {
    clearSummaryError();
    summaryBusy = true;
    summaryControls();
    const provider = byId("briefing-server").value;
    const isCloud = summary.isCloudProvider ? summary.isCloudProvider(provider) : false;
    byId("summary-status").textContent = isCloud ?
      `Connecting Today briefing to ${summary.serverLabelForProvider(provider)}...` :
      "Checking installed models for Today briefing...";
    try {
      await ensureProviderPermission(provider);
      let apiKey = "";
      if (isCloud) {
        const usePrimaryKey = provider === byId("summary-server").value;
        apiKey = ((usePrimaryKey ? byId("summary-api-key")?.value : byId("briefing-api-key")?.value) ||
          providerCredentials[provider] || "").trim();
        if (store.saveProviderCredential && apiKey) {
          providerCredentials = await store.saveProviderCredential(provider, apiKey);
        }
      }
      briefingModelList = await summaryClient.request(
        isCloud ? { type: "models", provider, apiKey } : { type: "models", provider },
        { signal: summaryController.signal }
      );
      const selected = byId("briefing-model").value || summary.recommendedModel(briefingModelList);
      briefingModelOptions(selected);
      byId("summary-status").textContent = briefingModelList.length ?
        "Connected Today briefing provider. Choose a model and save your settings." :
        "No eligible models were found on the selected Today briefing provider.";
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
    const isCloud = summary.isCloudProvider ? summary.isCloudProvider(byId("summary-server").value) : false;
    if (isCloud && byId("summary-automatic")) {
      byId("summary-automatic").checked = false;
    }
    byId("summary-status").textContent = isCloud ?
      "Enter your token and connect to list models on the selected cloud provider." :
      "Connect to list models on the selected local server.";
  });

  byId("briefing-server")?.addEventListener("change", () => {
    briefingModelList = null;
    summaryDirty = true;
    briefingModelOptions("");
    clearSummaryError();
    summaryControls();
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
        throw new Error("Connect to your provider and choose an available model before saving.");
      }
      const provider = summary.providerForModel(model);
      const allowedProviders = summary.ALL_PROVIDERS || ["ollama", "lmstudio", "mlx", "splash", "copilot", "openai", "anthropic", "gemini"];
      if (!allowedProviders.includes(provider)) {
        throw new Error("Unsupported provider. Choose Splash, Ollama, LM Studio, MLX, GitHub Copilot, OpenAI, Anthropic, or Gemini.");
      }
      if (summary.isCloudProvider?.(provider) && store.saveProviderCredential) {
        const key = (byId("summary-api-key")?.value || providerCredentials[provider] || "").trim();
        if (!key) throw new Error(`Enter an API token for ${summary.serverLabelForProvider(provider)} before saving.`);
        providerCredentials = await store.saveProviderCredential(provider, key);
      }
      const briefingProvider = byId("briefing-server")?.value || "";
      const briefingModel = briefingProvider ? (byId("briefing-model")?.value || "") : "";
      if (briefingProvider && (!briefingModel || (briefingModelList && !briefingModelList.some((entry) => entry.id === briefingModel)))) {
        throw new Error("Connect your Today briefing provider and choose a model, or select 'Same as row summaries model'.");
      }
      if (briefingModel && summary.isCloudProvider?.(summary.providerForModel(briefingModel)) && store.saveProviderCredential) {
        const bProv = summary.providerForModel(briefingModel);
        const key = ((bProv === provider ? byId("summary-api-key")?.value : byId("briefing-api-key")?.value) ||
          providerCredentials[bProv] || "").trim();
        if (!key) throw new Error(`Enter an API token for ${summary.serverLabelForProvider(bProv)} before saving.`);
        providerCredentials = await store.saveProviderCredential(bProv, key);
      }
      const manualOnly = Boolean(byId("summary-manual-only")?.checked);
      summarySettings = await store.saveSummarySettings({
        model,
        automatic: manualOnly ? false : byId("summary-automatic").checked,
        ...(briefingModel ? { briefingModel } : {}),
        ...(manualOnly ? { manualOnly: true } : {})
      });
      summaryDirty = false;
      byId("summary-status").textContent = summarySettings.automatic ?
        "Saved. Linked comments will be summarized when you open a notifications view." :
        summarySettings.manualOnly ?
        "Saved. Manual row clicks only is on (bulk Summarize comments is disabled)." :
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
      if (byId("briefing-server")) byId("briefing-server").value = "";
      briefingModelOptions("");
      byId("summary-automatic").checked = false;
      if (byId("summary-manual-only")) byId("summary-manual-only").checked = false;
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
