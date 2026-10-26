(function exposeStore(root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.GitHubSubscriptions;
  const summary = typeof module === "object" && module.exports ? require("./summary.js") : root.GitHubSubscriptionSummary;
  const api = factory(core, summary);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionStore = api;
})(globalThis, function createStoreApi(core, summary) {
  "use strict";

  const REVIEW_PREFIX = "review:v1:";
  const CACHE_PREFIX = "summary-cache:v2:";
  const CACHE_RESET_KEY = "summary-cache:reset";
  const REVIEW_RESET_KEY = "review:reset";
  const CACHE_LIMIT = 200;
  const CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function account(value) {
    const login = core.normalizeLogin(value);
    if (!login) throw new Error("GitHub's signed-in username is unavailable. Reload GitHub to use local review state and saved summaries.");
    return login;
  }

  function activityToken(item) {
    const parsed = core.parseItem(item?.href || item?.url);
    if (!parsed || !item?.dateTime || !Number.isFinite(Date.parse(item.dateTime))) return "";
    return JSON.stringify([
      parsed.key, new Date(item.dateTime).toISOString(), core.commentTarget(item.href)?.id || "",
      core.cleanText(item.title, 1024), core.cleanText(item.state, 100)
    ]);
  }

  function validateActivity(value, key, message = "The notification update identity is unreadable. Refresh the inbox.") {
    let fields;
    try {
      fields = JSON.parse(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(message);
    }
    if (!Array.isArray(fields) || fields.length !== 5 || fields[0] !== key ||
        typeof fields[1] !== "string" || !Number.isFinite(Date.parse(fields[1])) ||
        new Date(fields[1]).toISOString() !== fields[1] ||
        typeof fields[2] !== "string" || (fields[2] && !/^(?:(?:issuecomment-|discussioncomment-|pullrequestreview-|commitcomment-|discussion_r|r)\d+|thread)$/.test(fields[2])) ||
        typeof fields[3] !== "string" || fields[3].length > 1024 ||
        typeof fields[4] !== "string" || fields[4].length > 100) {
      throw new Error(message);
    }
    return fields;
  }

  function reviewKey(viewer, key) {
    return REVIEW_PREFIX + account(viewer) + ":" + key;
  }

  function cacheKey(viewer, key) {
    return CACHE_PREFIX + account(viewer) + ":" + key;
  }

  function validTimestamp(value) {
    return Number.isFinite(value) && value > 0;
  }

  function validateReview(value, key) {
    if (!value || !validTimestamp(value.markedAt)) {
      throw new Error("A local caught-up marker is unreadable. Reset caught-up state in AI settings.");
    }
    validateActivity(value.activity, key, "A local caught-up marker is unreadable. Reset caught-up state in AI settings.");
    return { activity: value.activity, markedAt: value.markedAt };
  }

  function validateCache(value) {
    const target = core.commentTarget(value?.href);
    if (!target || value.href !== `${target.url}#${target.id}` ||
        !core.normalizeLogin(value.viewer) || core.normalizeLogin(value.viewer) !== value.viewer ||
        typeof value.model !== "string" || !value.model ||
        !Number.isInteger(value.summaryVersion) || typeof value.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(value.fingerprint) ||
        typeof value.activity !== "string" || typeof value.author !== "string" || value.author.length > 100 ||
        typeof value.dateTime !== "string" || (value.dateTime && !Number.isFinite(Date.parse(value.dateTime))) ||
        typeof value.truncated !== "boolean" || !validTimestamp(value.generatedAt) ||
        !validTimestamp(value.checkedAt) || value.generatedAt > value.checkedAt) {
      throw new Error("A saved summary is unreadable. Clear saved summaries in AI settings, then retry.");
    }
    if (value.activity) {
      const fields = validateActivity(value.activity, target.key, "A saved summary's update identity is unreadable. Clear saved summaries in AI settings.");
      if ((fields[2] || "thread") !== target.id) throw new Error("The saved summary belongs to a different comment. Clear saved summaries in AI settings.");
    }
    let result;
    try {
      summary.validateSettings({ model: value.model, automatic: false });
      result = summary.validateResult(value.result, { viewer: value.viewer, author: value.author, text: value.result?.evidence || "" });
    } catch (error) {
      if (error?.name !== "LocalSummaryError") throw error;
      throw new Error("A saved summary is unreadable. Clear saved summaries in AI settings, then retry.", { cause: error });
    }
    return {
      viewer: value.viewer, href: value.href, model: value.model, summaryVersion: value.summaryVersion,
      fingerprint: value.fingerprint, activity: value.activity,
      result,
      author: value.author, dateTime: value.dateTime, truncated: value.truncated,
      generatedAt: value.generatedAt, checkedAt: value.checkedAt
    };
  }

  async function sourceFingerprint(value) {
    const target = core.commentTarget(value.href);
    if (!target) throw new Error("An exact linked comment is required for a saved summary.");
    const input = JSON.stringify([
      summary.SUMMARY_VERSION, account(value.viewer), target.url, target.id, value.model,
      value.title, value.author, value.dateTime, value.text, value.truncated
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function validateFilter(value) {
    if (!value || typeof value.name !== "string" || typeof value.enabled !== "boolean") {
      throw new Error("The local filter is unreadable. Reload the extension before changing it.");
    }
    const name = core.cleanText(value.name, 1000);
    if (!name || name.length > 40) throw new Error("Use a filter name between 1 and 40 characters.");
    return { name, enabled: value.enabled };
  }

  function createStore(area) {
    async function list() {
      const values = await area.get(null);
      const items = [];
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith(core.STORAGE_PREFIX)) continue;
        const item = core.parseItem(value?.url);
        if (!item || key !== core.STORAGE_PREFIX + item.key || !Number.isFinite(value.savedAt)) {
          throw new Error("A saved subscription is unreadable. Reload the extension before changing your list.");
        }
        items.push({ ...item, savedAt: value.savedAt });
      }
      return items.sort((a, b) => b.savedAt - a.savedAt || a.key.localeCompare(b.key));
    }

    async function add(items) {
      const parsed = items.map((item) => core.parseItem(typeof item === "string" ? item : item.url));
      if (parsed.some((item) => !item)) throw new Error("Use a supported github.com item link.");
      const keys = parsed.map((item) => core.STORAGE_PREFIX + item.key);
      const existing = keys.length ? await area.get(keys) : {};
      const updates = {};
      for (const item of parsed) {
        const key = core.STORAGE_PREFIX + item.key;
        if (!Object.hasOwn(existing, key)) updates[key] = { url: item.url, savedAt: Date.now() };
      }
      // One storage key per item prevents unrelated edits in different tabs
      // from overwriting each other with stale copies of an entire list.
      if (Object.keys(updates).length) await area.set(updates);
      return Object.keys(updates).length;
    }

    async function remove(item) {
      const parsed = core.parseItem(typeof item === "string" ? item : item.url);
      if (!parsed) throw new Error("This subscription could not be identified.");
      const values = await area.get(null);
      const related = Object.keys(values).filter((key) =>
        (key.startsWith(REVIEW_PREFIX) || key.startsWith(CACHE_PREFIX)) && key.endsWith(":" + parsed.key));
      await area.remove([core.STORAGE_PREFIX + parsed.key, ...related]);
    }

    async function getFilter() {
      const values = await area.get([core.FILTER_STORAGE_KEY]);
      return Object.hasOwn(values, core.FILTER_STORAGE_KEY) ?
        validateFilter(values[core.FILTER_STORAGE_KEY]) : { ...core.DEFAULT_FILTER };
    }

    async function saveFilter(value) {
      const filter = validateFilter(value);
      await area.set({ [core.FILTER_STORAGE_KEY]: filter });
      return filter;
    }

    async function getPriorityRules() {
      const values = await area.get([core.PRIORITY_RULES_STORAGE_KEY]);
      return Object.hasOwn(values, core.PRIORITY_RULES_STORAGE_KEY) ?
        core.validatePriorityRules(values[core.PRIORITY_RULES_STORAGE_KEY]) :
        { contacts: {}, coreRepos: [], adjacentRepos: [] };
    }

    async function savePriorityRules(value) {
      const rules = core.validatePriorityRules(value);
      await area.set({ [core.PRIORITY_RULES_STORAGE_KEY]: rules });
      return rules;
    }

    async function getSummarySettings() {
      const values = await area.get([summary.STORAGE_KEY]);
      return Object.hasOwn(values, summary.STORAGE_KEY) ?
        summary.validateSettings(values[summary.STORAGE_KEY]) : { ...summary.DEFAULT_SETTINGS };
    }

    async function saveSummarySettings(value) {
      const settings = summary.validateSettings(value);
      await area.set({ [summary.STORAGE_KEY]: settings });
      return settings;
    }

    async function getProviderCredentials() {
      const key = summary.CREDENTIALS_STORAGE_KEY || "summaries:v1:credentials";
      const values = await area.get([key]);
      const raw = values?.[key];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out = {};
      for (const provider of summary.CLOUD_PROVIDERS || ["copilot", "openai", "anthropic", "gemini"]) {
        if (typeof raw[provider] === "string" && raw[provider].trim()) {
          out[provider] = raw[provider].trim().slice(0, 500);
        }
      }
      return out;
    }

    async function saveProviderCredential(provider, apiKey) {
      const allowed = summary.CLOUD_PROVIDERS || ["copilot", "openai", "anthropic", "gemini"];
      if (!allowed.includes(provider)) throw new Error("Unsupported cloud provider.");
      const key = summary.CREDENTIALS_STORAGE_KEY || "summaries:v1:credentials";
      const existing = await getProviderCredentials();
      const trimmed = typeof apiKey === "string" ? apiKey.trim().slice(0, 500) : "";
      if (trimmed) existing[provider] = trimmed;
      else delete existing[provider];
      if (Object.keys(existing).length) await area.set({ [key]: existing });
      else await area.remove(key);
      return existing;
    }

    async function listReviews(viewer) {
      const prefix = REVIEW_PREFIX + account(viewer) + ":";
      const values = await area.get(null);
      return new Map(Object.entries(values).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => {
        const itemKey = key.slice(prefix.length);
        return [itemKey, validateReview(value, itemKey)];
      }));
    }

    async function setCaughtUp(viewer, item, caughtUp) {
      const parsed = core.parseItem(item?.href || item?.url);
      const activity = activityToken(item);
      if (!parsed || !activity || typeof caughtUp !== "boolean") {
        throw new Error("GitHub did not provide an update time for this item. It cannot be marked caught up safely.");
      }
      const key = reviewKey(viewer, parsed.key);
      const values = await area.get([key]);
      const previous = Object.hasOwn(values, key) ? validateReview(values[key], parsed.key) : null;
      if (caughtUp) {
        if (previous && JSON.parse(previous.activity)[1] > JSON.parse(activity)[1]) {
          throw new Error("A newer update was already reviewed in another tab. Refresh this inbox.");
        }
        await area.set({ [key]: { activity, markedAt: Date.now() } });
      } else {
        if (previous && previous.activity !== activity) {
          throw new Error("This item's caught-up state changed in another tab. Refresh before undoing it.");
        }
        await area.remove(key);
      }
    }

    async function getCachedSummary(viewer, item, model, matchActivity = true) {
      const target = (core.summaryTarget || core.commentTarget)(item?.href);
      if (!target || !model) return null;
      const key = cacheKey(viewer, target.key);
      const values = await area.get([key]);
      if (!Object.hasOwn(values, key)) return null;
      const value = validateCache(values[key]);
      if (value.viewer !== account(viewer) || core.commentTarget(value.href).key !== target.key) {
        throw new Error("A saved summary's account or item does not match its storage key. Clear saved summaries in AI settings.");
      }
      if (value.summaryVersion !== summary.SUMMARY_VERSION || value.model !== model ||
          value.href !== `${target.url}#${target.id}` || Date.now() - value.checkedAt > CACHE_AGE_MS ||
          value.checkedAt > Date.now() + 60000 ||
          (matchActivity && (!value.activity || value.activity !== activityToken(item)))) return null;
      return value;
    }

    async function saveCachedSummary(value) {
      const record = validateCache(value);
      const key = cacheKey(record.viewer, core.commentTarget(record.href).key);
      const values = await area.get(null);
      const others = Object.entries(values).filter(([entry]) => entry.startsWith(CACHE_PREFIX) && entry !== key);
      const expired = others.filter(([, entry]) => !validTimestamp(entry?.checkedAt) ||
        Date.now() - entry.checkedAt > CACHE_AGE_MS || entry.checkedAt > Date.now() + 60000);
      const expiredKeys = new Set(expired.map(([entry]) => entry));
      const live = others.filter(([entry]) => !expiredKeys.has(entry)).sort((left, right) => right[1].checkedAt - left[1].checkedAt);
      const removed = [...expiredKeys, ...live.slice(CACHE_LIMIT - 1).map(([entry]) => entry)];
      if (removed.length) await area.remove(removed);
      await area.set({ [key]: record });
      return record;
    }

    async function deleteCachedSummary(viewer, href) {
      const target = (core.summaryTarget || core.commentTarget)(href);
      if (!target) throw new Error("The saved summary's item could not be identified.");
      const key = cacheKey(viewer, target.key);
      const values = await area.get([key]);
      if (values[key]?.href === `${target.url}#${target.id}`) await area.remove(key);
    }

    async function localDataCounts() {
      const values = await area.get(null);
      return {
        summaries: Object.keys(values).filter((key) => key.startsWith(CACHE_PREFIX)).length,
        reviews: Object.keys(values).filter((key) => key.startsWith(REVIEW_PREFIX)).length
      };
    }

    async function clearLocalData(kind) {
      if (!["summaries", "reviews"].includes(kind)) throw new Error("Choose saved summaries or caught-up state to clear.");
      const prefix = kind === "summaries" ? CACHE_PREFIX : REVIEW_PREFIX;
      const marker = kind === "summaries" ? CACHE_RESET_KEY : REVIEW_RESET_KEY;
      const values = await area.get(null);
      const keys = Object.keys(values).filter((key) => key.startsWith(prefix));
      if (keys.length) await area.remove(keys);
      await area.set({ [marker]: crypto.randomUUID() });
      return keys.length;
    }

    return {
      list, add, remove, getFilter, saveFilter, getPriorityRules, savePriorityRules,
      getSummarySettings, saveSummarySettings, getProviderCredentials, saveProviderCredential,
      listReviews, setCaughtUp, getCachedSummary, saveCachedSummary, deleteCachedSummary,
      localDataCounts, clearLocalData
    };
  }

  function isSubscriptionChange(changes, areaName) {
    return areaName === "local" && Object.keys(changes).some((key) => key.startsWith(core.STORAGE_PREFIX));
  }

  function isFilterChange(changes, areaName) {
    return areaName === "local" && Object.hasOwn(changes, core.FILTER_STORAGE_KEY);
  }

  function isPriorityRulesChange(changes, areaName) {
    return areaName === "local" && Object.hasOwn(changes, core.PRIORITY_RULES_STORAGE_KEY);
  }

  function isSummaryChange(changes, areaName) {
    return areaName === "local" && Object.hasOwn(changes, summary.STORAGE_KEY);
  }

  function isReviewChange(changes, areaName) {
    return areaName === "local" && Object.keys(changes).some((key) => key.startsWith(REVIEW_PREFIX) || key === REVIEW_RESET_KEY);
  }

  function isCacheChange(changes, areaName) {
    return areaName === "local" && Object.keys(changes).some((key) => key.startsWith(CACHE_PREFIX) || key === CACHE_RESET_KEY);
  }

  return {
    createStore, isSubscriptionChange, isFilterChange, isPriorityRulesChange, isSummaryChange, isReviewChange, isCacheChange,
    activityToken, validateActivity, sourceFingerprint, reviewKey, cacheKey,
    REVIEW_PREFIX, CACHE_PREFIX, CACHE_RESET_KEY, REVIEW_RESET_KEY, CACHE_LIMIT, CACHE_AGE_MS
  };
});
