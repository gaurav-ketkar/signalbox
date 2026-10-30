(function exposeCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptions = api;
})(globalThis, function createCore() {
  "use strict";

  const ORIGIN = "https://github.com";
  const FILTER_HASH = "#subscriptions";
  const FILTER_QUERY = "subscriptions:only";
  const PRIORITY_HASH = "#priority";
  const PRIORITY_QUERY = "priority:only";
  const TODAY_HASH = "#today";
  const TODAY_QUERY = "today:only";
  const PRIORITY_THRESHOLD = 35;
  const PRIORITY_RULES_STORAGE_KEY = "priority:v1:rules";
  const DEFAULT_PRIORITY_RULES = Object.freeze({
    contacts: Object.freeze({}),
    coreRepos: Object.freeze([]),
    adjacentRepos: Object.freeze([])
  });
  const FILTER_STORAGE_KEY = "filter:v1:subscriptions";
  const DEFAULT_FILTER = Object.freeze({ name: "Subscriptions", enabled: true });
  const STORAGE_PREFIX = "subscription:v1:";
  const TYPE_LABELS = {
    issue: "Issue",
    pull: "Pull request",
    discussion: "Discussion",
    release: "Release",
    commit: "Commit"
  };

  function validatePriorityRules(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Priority rules must be a JSON object with contacts, coreRepos, or adjacentRepos.");
    }
    const contacts = {};
    if (value.contacts !== undefined) {
      if (!value.contacts || typeof value.contacts !== "object" || Array.isArray(value.contacts)) {
        throw new Error("Priority contacts must be an object mapping GitHub usernames to { points, tier, role }.");
      }
      for (const [rawLogin, entry] of Object.entries(value.contacts)) {
        const login = normalizeLogin(rawLogin.replace(/^@/, "").trim());
        if (!login || !entry || typeof entry !== "object") {
          throw new Error(`Invalid priority contact entry for "${rawLogin}".`);
        }
        const points = typeof entry.points === "number" && Number.isFinite(entry.points) ?
          Math.max(1, Math.min(30, Math.round(entry.points))) : 18;
        const tier = [1, 2, 3].includes(entry.tier) ? entry.tier : (points >= 28 ? 1 : points >= 20 ? 2 : 3);
        const role = cleanText(entry.role || `Tier ${tier}`, 80) || `Tier ${tier}`;
        contacts[login] = { points, tier, role };
      }
    }
    function normalizeRepoList(list, label) {
      if (list === undefined) return [];
      if (!Array.isArray(list)) throw new Error(`${label} must be an array of "owner/repo" strings.`);
      const repos = new Set();
      for (const entry of list) {
        if (typeof entry !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(entry.trim())) {
          throw new Error(`Invalid repository "${entry}" in ${label}; expected "owner/repo".`);
        }
        repos.add(entry.trim().toLowerCase());
      }
      return [...repos];
    }
    return {
      contacts,
      coreRepos: normalizeRepoList(value.coreRepos, "coreRepos"),
      adjacentRepos: normalizeRepoList(value.adjacentRepos, "adjacentRepos")
    };
  }

  function cleanText(value, limit = 300) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalizeLogin(value) {
    return typeof value === "string" && value === value.trim() && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) ?
      value.toLowerCase() : "";
  }

  function githubUrl(value, base = ORIGIN) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), base);
      return url.origin === ORIGIN && !url.username && !url.password ? url : null;
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }

  function parseItem(value) {
    if (typeof value !== "string") return null;
    let input = value.trim();
    const shorthand = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(input);
    if (shorthand) input = `${ORIGIN}/${shorthand[1]}/${shorthand[2]}/issues/${shorthand[3]}`;
    if (!/^(?:https:\/\/github\.com\/|\/(?!\/))/i.test(input)) return null;

    const url = githubUrl(input);
    if (!url) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/(issues|pull|discussions|releases\/tag|commit)\/(.+?)\/?$/.exec(url.pathname);
    if (!match || [".", ".."].includes(match[1]) || [".", ".."].includes(match[2])) return null;

    const owner = match[1].toLowerCase();
    const repo = match[2].toLowerCase();
    const repository = `${owner}/${repo}`;
    const pathType = match[3];
    const identifier = match[4];
    let type;
    let key;
    let label;
    let path;

    if (["issues", "pull", "discussions"].includes(pathType)) {
      const number = /^([1-9]\d*)(?:\/.*)?$/.exec(identifier)?.[1];
      if (!number) return null;
      type = { issues: "issue", pull: "pull", discussions: "discussion" }[pathType];
      // GitHub issues and PRs share a number space; discussions do not.
      key = type === "discussion" ? `${repository}/discussion#${number}` : `${repository}#${number}`;
      label = `${repository}${type === "discussion" ? " discussion " : "#"}${number}`;
      path = `${repository}/${pathType}/${number}`;
    } else if (pathType === "commit") {
      if (!/^[a-f\d]{40}$/i.test(identifier)) return null;
      type = "commit";
      const sha = identifier.toLowerCase();
      key = `${repository}/commit/${sha}`;
      label = `${repository}@${sha.slice(0, 7)}`;
      path = `${repository}/commit/${sha}`;
    } else {
      let tag;
      try {
        tag = decodeURIComponent(identifier);
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
      if (!tag || /[\u0000-\u001f\u007f]/.test(tag)) return null;
      type = "release";
      key = `${repository}/release/${tag}`;
      label = `${repository} release ${tag}`;
      path = `${repository}/releases/tag/${encodeURIComponent(tag)}`;
    }

    return { key, owner, repo, repository, type, label, url: `${ORIGIN}/${path}` };
  }

  // GitHub labels states differently across rows, hovercards, and pages
  // ("Status: Closed as not planned", "Not planned", "Merged"). Saved items
  // keep one of four plain values; anything unrecognized is left unknown.
  function normalizeState(value) {
    const text = cleanText(value, 100).toLowerCase().replace(/^status:\s*/, "");
    if (text.startsWith("merged")) return "merged";
    if (text.startsWith("closed") || text.startsWith("not planned")) return "closed";
    if (text.startsWith("draft")) return "draft";
    if (text.startsWith("open")) return "open";
    return "";
  }

  // Reads an item's title from its own page title, for example
  // "Fix login · Issue #12 · owner/repo · GitHub". The trailing metadata must
  // name this exact item, so a page that is still showing the previous item's
  // title never lends it to the next one. Release page titles don't name the
  // tag, so releases rely on notification rows instead.
  function titleFromDocumentTitle(value, item) {
    const parsed = parseItem(item?.url);
    if (!parsed || typeof value !== "string") return "";
    const parts = value.split(" · ").map((part) => part.trim());
    if (parts.length < 3 || parts.at(-1) !== "GitHub") return "";
    const repository = parsed.repository;
    let titleParts = null;
    if (parsed.type === "issue" || parsed.type === "pull") {
      const kind = /^(Issue|Pull Request) #([1-9]\d*)$/.exec(parts.at(-3));
      if (parts.length >= 4 && kind && kind[2] === parsed.key.split("#")[1] && parts.at(-2).toLowerCase() === repository) {
        titleParts = parts.slice(0, -3);
        // Pull request pages append " by <author>" to the title.
        if (kind[1] === "Pull Request") titleParts.push(titleParts.pop().replace(/\s+by\s+[\w-]+(?:\[bot\])?$/, ""));
      }
    } else if (parsed.type === "discussion") {
      if (parts.length >= 4 && parts.at(-2) === `Discussion #${parsed.key.split("#")[1]}` && parts.at(-3).toLowerCase() === repository) {
        titleParts = parts.slice(0, -3);
      }
    } else if (parsed.type === "commit") {
      if (parts.at(-2).toLowerCase() === `${repository}@${parsed.key.split("/commit/")[1].slice(0, 7)}`) titleParts = parts.slice(0, -2);
    }
    const title = cleanText(titleParts?.join(" · "), 300);
    return title && title !== parsed.label ? title : "";
  }

  function parseInput(value) {
    const entries = String(value ?? "").trim().split(/\s+/).filter(Boolean);
    const unique = new Map();
    const invalid = [];
    let duplicates = 0;
    for (const entry of entries) {
      const item = parseItem(entry);
      if (!item) invalid.push(entry);
      else if (unique.has(item.key)) duplicates += 1;
      else unique.set(item.key, item);
    }
    return { items: [...unique.values()], invalid, duplicates };
  }

  function notificationPageUrl(value, base = `${ORIGIN}/notifications`) {
    const url = githubUrl(value, base);
    if (!url || !/^\/notifications\/?$/.test(url.pathname)) return null;
    url.hash = "";
    return url.href;
  }

  function isNotifications(value) {
    return notificationPageUrl(value) !== null;
  }

  function isSubscriptionQuery(value) {
    return typeof value === "string" && value.trim().toLowerCase() === FILTER_QUERY;
  }

  function isSubscriptionView(value) {
    const url = githubUrl(value);
    return isNotifications(value) && (url.hash === FILTER_HASH ||
      isSubscriptionQuery(url.searchParams.get("query")));
  }

  function isPriorityQuery(value) {
    return typeof value === "string" && value.trim().toLowerCase() === PRIORITY_QUERY;
  }

  function isPriorityView(value) {
    const url = githubUrl(value);
    return isNotifications(value) && (url.hash === PRIORITY_HASH ||
      isPriorityQuery(url.searchParams.get("query")));
  }

  function isTodayQuery(value) {
    return typeof value === "string" && value.trim().toLowerCase() === TODAY_QUERY;
  }

  function isTodayView(value) {
    const url = githubUrl(value);
    return isNotifications(value) && (url.hash === TODAY_HASH ||
      isTodayQuery(url.searchParams.get("query")));
  }

  function scorePriority(item, {
    now = Date.now(),
    subscribed = false,
    author = "",
    summaryResponse = "",
    kev = null,
    rules = DEFAULT_PRIORITY_RULES
  } = {}) {
    const contacts = rules?.contacts && typeof rules.contacts === "object" ? rules.contacts : DEFAULT_PRIORITY_RULES.contacts;
    const coreRepos = new Set(Array.isArray(rules?.coreRepos) ? rules.coreRepos.map((r) => String(r).toLowerCase()) : []);
    const adjacentRepos = new Set(Array.isArray(rules?.adjacentRepos) ? rules.adjacentRepos.map((r) => String(r).toLowerCase()) : []);
    const reason = String(item?.reason || "").trim().toLowerCase().replace(/[_ ]+/g, "-");
    const state = String(item?.state || "").trim().toLowerCase();
    const isClosedOrMerged = state === "closed" || state === "merged" || state === "not planned";
    const directReason = reason === "assign" || reason === "mention" || reason === "review-requested";

    let askScore = 5;
    if (reason === "assign" || reason === "mention") askScore = 30;
    else if (reason === "author") askScore = 22;
    else if (reason === "review-requested") askScore = 10;
    else if (reason === "comment" || reason === "commented") askScore = 12;
    else if (reason === "team-mention") askScore = 6;
    else if (reason === "security-alert" || reason === "invitation") askScore = 18;
    if (subscribed) askScore = Math.max(askScore, 20) + (askScore >= 20 ? 5 : 0);
    if (item?.unread) askScore += 4;
    askScore = Math.min(45, askScore);

    let resolvedPenalty = 1;
    if (kev && typeof kev === "object") {
      const directAsk = typeof kev.directAsk === "number" && Number.isFinite(kev.directAsk) ?
        Math.max(0, Math.min(1, kev.directAsk)) : 0;
      const blocker = typeof kev.blocker === "number" && Number.isFinite(kev.blocker) ?
        Math.max(0, Math.min(1, kev.blocker)) : 0;
      const resolved = typeof kev.resolved === "number" && Number.isFinite(kev.resolved) ?
        Math.max(0, Math.min(1, kev.resolved)) : 0;
      const urgency = typeof kev.urgency === "number" && Number.isFinite(kev.urgency) ?
        Math.max(0, Math.min(3, kev.urgency)) : 0;
      resolvedPenalty = 1 - 0.65 * resolved;
      const rawKev = (30 * directAsk + 10 * blocker + 4 * urgency) * resolvedPenalty;
      const kevScore = Math.min(45, Math.round(rawKev));
      if (kev.response === "needs_response" || directAsk >= 0.65) {
        askScore = Math.max(askScore, kevScore, 38);
      } else if ((kev.response === "fyi" && directAsk < 0.2 && reason !== "assign") || resolved >= 0.75) {
        askScore = Math.min(askScore, Math.max(6, Math.round(kevScore)));
      } else {
        askScore = Math.max(askScore, kevScore);
      }
    }

    if (summaryResponse === "needs_response") {
      askScore = 45;
      resolvedPenalty = 1;
    } else if (summaryResponse === "unclear") {
      askScore = Math.max(askScore, 30);
    } else if (summaryResponse === "fyi" && reason !== "assign") {
      askScore = Math.min(askScore, subscribed ? 16 : 8);
    }

    let orgScore = 0;
    let orgMatch = null;
    const matchedContacts = new Map();
    const candidates = [
      ...(Array.isArray(item?.participants) ? item.participants.map((person) => person?.username || person) : []),
      author
    ];
    for (const candidate of candidates) {
      const login = normalizeLogin(String(candidate || "").replace(/^@/, ""));
      if (!login || !Object.hasOwn(contacts, login)) continue;
      const info = contacts[login];
      matchedContacts.set(login, info);
      if (info.points > orgScore) {
        orgScore = info.points;
        orgMatch = { username: login, points: info.points, tier: info.tier, role: info.role };
      }
    }
    // Multi-stakeholder convergence bonus (+5 pts when 2+ leadership/squad contacts are active on the same thread)
    const multiContactBonus = matchedContacts.size >= 2 ? 5 : 0;
    const repoName = String(item?.repository || "").toLowerCase();
    const coreRepoBonus = coreRepos.has(repoName) ? 6 : adjacentRepos.has(repoName) ? 4 : 0;
    if (askScore < 12 && !directReason) {
      orgScore = Math.round(orgScore * 0.6);
    }
    orgScore = Math.min(30, orgScore + multiContactBonus + coreRepoBonus);

    const activeOpenAsk = !isClosedOrMerged && (
      summaryResponse === "needs_response" ||
      (kev?.directAsk >= 0.5 && kev?.resolved < 0.5) ||
      (directReason && item?.unread && summaryResponse !== "fyi")
    );

    let recencyScore = 8;
    let isStaleThread = false;
    const timestamp = item?.dateTime ? Date.parse(item.dateTime) : NaN;
    if (Number.isFinite(timestamp)) {
      const ageHours = Math.max(0, (now - timestamp) / 3600000);
      isStaleThread = ageHours > 14 * 24;
      if (activeOpenAsk && ageHours <= 72) {
        // Unanswered open asks stay hot across a 3-day SLA window instead of decaying away overnight.
        recencyScore = ageHours <= 36 ? 25 : Math.round(25 * Math.pow(0.5, (ageHours - 36) / 36));
      } else {
        recencyScore = Math.max(0, Math.min(25, Math.round(25 * Math.pow(0.5, ageHours / 24))));
      }
    }

    let rawTotal = askScore + orgScore + recencyScore;
    if (askScore >= 28 && orgScore >= 22 && !isStaleThread) {
      rawTotal = Math.round(rawTotal * 1.1);
    }
    if (isStaleThread && reason !== "assign" && summaryResponse !== "needs_response" && !(kev?.directAsk >= 0.65)) {
      rawTotal = Math.round(rawTotal * 0.6);
    }
    if (isClosedOrMerged && summaryResponse !== "needs_response" && !(kev?.directAsk >= 0.65)) {
      rawTotal = Math.round(rawTotal * 0.45);
    }

    const score = Math.min(100, Math.max(0, rawTotal));
    const tier = score >= 70 ? "P1" : score >= 50 ? "P2" : "P3";
    // Require meaningful ask or org contact signal so subscribed/team-mention noise in a core repo cannot qualify on recency alone.
    const hasSignal = askScore >= 16 || matchedContacts.size > 0;
    const qualifies = hasSignal && score >= PRIORITY_THRESHOLD;
    const parts = [
      `Ask ${askScore}/45`,
      orgMatch ? `Org ${orgScore}/30 (@${orgMatch.username}, ${orgMatch.role})` : `Org ${orgScore}/30`,
      `${activeOpenAsk ? "SLA/Recency" : "Recency"} ${recencyScore}/25`,
      ...(isStaleThread && reason !== "assign" ? ["Stale >14d ×0.6"] : []),
      ...(isClosedOrMerged ? [`${item.state} ×0.45`] : [])
    ];
    return {
      score,
      tier,
      askScore,
      orgScore,
      orgMatch,
      recencyScore,
      qualifies,
      breakdown: `Priority ${score}/100 (${parts.join(" + ")})`
    };
  }

  function classifySweep(item, {
    now = Date.now(),
    subscribed = false,
    author = "",
    summaryResponse = "",
    kev = null,
    rules = DEFAULT_PRIORITY_RULES
  } = {}) {
    if (subscribed || summaryResponse === "needs_response" || kev?.response === "needs_response") {
      return { sweepable: false, bucket: "", label: "" };
    }
    const reason = String(item?.reason || "").trim().toLowerCase().replace(/[_ ]+/g, "-");
    if (reason === "review-requested") {
      return { sweepable: true, bucket: "review-requested", label: "Review requested" };
    }
    if (reason === "team-mention") {
      return { sweepable: true, bucket: "team-mention", label: "Team mentioned" };
    }
    // Participating reasons on GitHub (excluding assign, which is direct ownership, and subscribed, which is non-participating)
    const isParticipatingReason = ["participating", "mention", "comment", "commented", "author", "state-change"].includes(reason);
    if (!isParticipatingReason) {
      return { sweepable: false, bucket: "", label: "" };
    }
    const state = String(item?.state || "").trim().toLowerCase();
    const isClosedOrMerged = state === "closed" || state === "merged" || state === "not planned";
    const confirmedIrrelevantByAi = summaryResponse === "fyi" ||
      (kev && kev.response === "fyi" && (kev.directAsk ?? 0) < 0.25 && (kev.blocker ?? 0) < 0.3);
    const staleOldComment = ["participating", "comment", "commented", "state-change"].includes(reason) &&
      item?.dateTime && (now - Date.parse(item.dateTime)) > 3 * 24 * 3600000 &&
      !scorePriority(item, { now, subscribed, author, summaryResponse, kev, rules }).qualifies;
    if (isClosedOrMerged || confirmedIrrelevantByAi || staleOldComment) {
      return { sweepable: true, bucket: "stale-participating", label: "Stale participating" };
    }
    return { sweepable: false, bucket: "", label: "" };
  }

  function commentTarget(value) {
    const item = parseItem(value);
    const url = githubUrl(value);
    if (!item || !url) return null;
    let id;
    try {
      id = decodeURIComponent(url.hash.slice(1));
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
    if (!/^(?:(?:issuecomment-|discussioncomment-|pullrequestreview-|commitcomment-|discussion_r|r)\d+|thread)$/.test(id)) return null;
    // Fetch the item, never the notification's tracking URL. Keep the exact
    // comment fragment separately so we cannot substitute a newer comment.
    return { id, url: item.url, key: item.key };
  }

  function summaryTarget(value) {
    const exact = commentTarget(value);
    if (exact) return exact;
    const item = parseItem(value);
    const url = githubUrl(value);
    if (!item || !url) return null;
    return { id: "thread", url: item.url, key: item.key };
  }

  return {
    ORIGIN,
    FILTER_HASH,
    FILTER_QUERY,
    PRIORITY_HASH,
    PRIORITY_QUERY,
    TODAY_HASH,
    TODAY_QUERY,
    PRIORITY_THRESHOLD,
    PRIORITY_RULES_STORAGE_KEY,
    DEFAULT_PRIORITY_RULES,
    FILTER_STORAGE_KEY,
    DEFAULT_FILTER,
    STORAGE_PREFIX,
    TYPE_LABELS,
    cleanText,
    normalizeLogin,
    githubUrl,
    parseItem,
    normalizeState,
    titleFromDocumentTitle,
    parseInput,
    notificationPageUrl,
    isNotifications,
    isSubscriptionQuery,
    isSubscriptionView,
    isPriorityQuery,
    isPriorityView,
    isTodayQuery,
    isTodayView,
    validatePriorityRules,
    scorePriority,
    classifySweep,
    commentTarget,
    summaryTarget
  };
});
