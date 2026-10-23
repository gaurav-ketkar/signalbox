(function exposeDom(root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.GitHubSubscriptions;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionDom = api;
})(globalThis, function createDomApi(core) {
  "use strict";

  const ROW_SELECTOR = ".notifications-list-item, [data-testid='notification-list-item']";
  const ROOT_SELECTOR = ".js-check-all-container, .js-notifications-list, [data-testid='notifications-list']";
  const NEXT_SELECTOR = "a[rel~='next'], a[aria-label='Next'], a[aria-label='Next page'], .pagination a.next_page";
  const REASONS = new Set([
    "assign", "author", "comment", "commented", "ci-activity", "invitation", "manual", "mention",
    "participating", "review-requested", "security-alert", "state-change", "subscribed", "team-mention"
  ]);
  const STATES = [
    [".octicon-git-merge", "Merged"],
    [".octicon-git-pull-request-closed", "Closed"],
    [".octicon-git-pull-request-draft", "Draft"],
    [".octicon-skip", "Not planned"],
    [".octicon-issue-closed", "Closed"],
    [".octicon-issue-opened, .octicon-git-pull-request", "Open"]
  ];

  function readReason(row) {
    const explicit = row.querySelector("[data-reason], [data-testid='notification-reason'], .notification-list-item-reason");
    if (explicit) {
      return {
        reason: core.cleanText(explicit.getAttribute("data-reason") || explicit.textContent, 100),
        reasonDescription: core.cleanText(explicit.getAttribute("title") || explicit.getAttribute("aria-label"), 400)
      };
    }
    // GitHub's current inbox uses a plain label rather than a reason data
    // attribute. Only accept known reason labels, outside the item title.
    for (const node of row.querySelectorAll(".Label, .label, span")) {
      if (node.children.length || node.closest("[data-gns-owned], .notification-list-item-link, [data-testid='notification-link']")) continue;
      const reason = core.cleanText(node.textContent, 100);
      if (REASONS.has(reason.toLowerCase().replace(/[_ ]/g, "-"))) {
        return {
          reason,
          reasonDescription: core.cleanText(node.getAttribute("title") || node.getAttribute("aria-label"), 400)
        };
      }
    }
    return { reason: "", reasonDescription: "" };
  }

  function readParticipants(row) {
    const participants = new Map();
    for (const anchor of row.querySelectorAll(".AvatarStack-body a.avatar, [data-testid='notification-participants'] a")) {
      const url = core.githubUrl(anchor.getAttribute("href"));
      const username = /^\/([\w-]+(?:\[bot\])?)\/?$/.exec(url?.pathname || "")?.[1];
      if (!username) continue;
      participants.set(username.toLowerCase(), { username, url: url.href });
    }
    return [...participants.values()];
  }

  function readRow(row) {
    const primary = [...row.querySelectorAll("a.notification-list-item-link, a[data-testid='notification-link']")];
    const anchors = primary.length ? primary : [...row.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      if (anchor.closest("[data-gns-owned]")) continue;
      const item = core.parseItem(anchor.getAttribute("href"));
      if (!item) continue;
      const titleNode = anchor.querySelector(".markdown-title, .notification-list-item-title, [data-testid='notification-title']") ||
        row.querySelector(".markdown-title, .notification-list-item-title, [data-testid='notification-title']");
      const time = row.querySelector("relative-time[datetime], time[datetime]");
      const dateTime = time?.getAttribute("datetime") || "";
      const href = core.githubUrl(anchor.getAttribute("href"))?.href;
      const notificationId = core.cleanText(
        row.getAttribute("data-notification-id") ||
        row.querySelector("input[name='notification_ids[]']")?.value || "",
        200
      );
      const archiveToken = core.cleanText(
        row.querySelector("form[action='/notifications/beta/archive'] input[name='authenticity_token']")?.value ||
        row.ownerDocument?.querySelector("form[action='/notifications/beta/archive'] input[name='authenticity_token']")?.value || "",
        300
      );
      const unmarkToken = core.cleanText(
        row.querySelector("form[action='/notifications/beta/unmark'] input[name='authenticity_token']")?.value ||
        row.ownerDocument?.querySelector("form[action='/notifications/beta/unmark'] input[name='authenticity_token']")?.value || "",
        300
      );
      return {
        ...item,
        href,
        notificationId,
        archiveToken,
        unmarkToken,
        title: core.cleanText(titleNode?.textContent || anchor.textContent, 1024) || item.label,
        ...readReason(row),
        participants: readParticipants(row),
        state: STATES.find(([selector]) => row.querySelector(selector))?.[1] || "",
        unread: row.classList.contains("notification-unread") || row.getAttribute("data-unread") === "true",
        dateTime: Number.isFinite(Date.parse(dateTime)) ? dateTime : "",
        timeText: core.cleanText(time?.textContent, 80)
      };
    }
    return null;
  }

  function readPage(document, pageUrl) {
    if (document.querySelector("form[action='/session'] input[type='password'], input[name='login'][id='login_field']")) {
      throw new Error("GitHub is asking you to sign in. Sign in, then refresh Subscriptions.");
    }
    const rows = [...document.querySelectorAll(ROW_SELECTOR)];
    const empty = [...document.querySelectorAll(".blankslate, [data-testid='notifications-empty-state']")]
      .some((node) => /(?:no .*notifications|no notifications|all caught up|inbox is empty)/i.test(node.textContent));
    if (!rows.length && !empty) {
      throw new Error("GitHub's notification list was not recognized. Open the inbox and refresh; the search is not complete.");
    }

    const items = rows.map(readRow).filter(Boolean);
    const nextAnchor = [...document.querySelectorAll(NEXT_SELECTOR)]
      .find((anchor) => !anchor.closest("[data-gns-owned]") &&
        anchor.getAttribute("aria-disabled") !== "true" && !anchor.classList.contains("disabled"));
    const next = nextAnchor ? core.notificationPageUrl(nextAnchor.getAttribute("href"), pageUrl) : null;
    if (nextAnchor && !next) throw new Error("GitHub returned an unexpected next-page link. The search was stopped.");
    if (!next) {
      const enabledNext = [...document.querySelectorAll("button[aria-label='Next'], button[aria-label='Next page']")]
        .some((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
      const counts = document.querySelector(".js-notifications-list-paginator-counts")?.textContent || "";
      const range = /([\d,]+)\s+of\s+([\d,]+)/i.exec(counts);
      const morePages = range && Number(range[1].replaceAll(",", "")) < Number(range[2].replaceAll(",", ""));
      if (enabledNext || morePages) {
        throw new Error("GitHub has more notifications, but its next-page link was not recognized. The search is incomplete.");
      }
    }
    // Grouped inboxes show only a few rows per repository and have no Next
    // link. Each "View all" destination can have its own paginated list.
    const additionalPages = new Set();
    for (const group of document.querySelectorAll(".js-notifications-group-view-all")) {
      if (group.closest("[data-gns-owned]")) continue;
      const links = [...group.querySelectorAll("a[href]")].filter((anchor) =>
        anchor.getAttribute("aria-disabled") !== "true" && !anchor.classList.contains("disabled"));
      if (!links.length) {
        throw new Error("GitHub has more notifications in a repository group, but its View all link was not recognized. The search is incomplete.");
      }
      for (const anchor of links) {
        const url = core.notificationPageUrl(anchor.getAttribute("href"), pageUrl);
        if (!url) throw new Error("GitHub returned an unexpected repository-group link. The search was stopped.");
        additionalPages.add(url);
      }
    }
    return { items, rowCount: rows.length, unidentified: rows.length - items.length, next, additionalPages: [...additionalPages] };
  }

  function nativeRoot(document) {
    return document.querySelector(ROOT_SELECTOR) ||
      document.querySelector(ROW_SELECTOR)?.closest(".Box") ||
      document.querySelector(".notifications-list, .blankslate");
  }

  function accessibleName(node) {
    return core.cleanText(node.getAttribute("aria-label") ||
      (node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) =>
        node.ownerDocument.getElementById(id)?.textContent || "").join(" "));
  }

  function filterLists(document) {
    return [...document.querySelectorAll("ul, ol, [role='list']")].filter((node) =>
      accessibleName(node).toLowerCase() === "filters" &&
      !node.closest("dialog, [role='dialog'], details-dialog, [data-gns-owned]"));
  }

  function filterForm(form) {
    if (!form?.matches("form")) return null;
    const url = core.githubUrl(form.getAttribute("action"));
    if (!/^\/notifications\/(?:beta\/)?create_custom_inbox\/?$/.test(url?.pathname || "")) return null;
    const name = form.querySelector("input[name='custom_inbox[name]'], input[aria-label='Inbox name']");
    const query = form.querySelector("input[name='custom_inbox[query_string]'], input[aria-label^='Filter inbox by']");
    return name && query ? { name, query } : null;
  }

  return { ROW_SELECTOR, ROOT_SELECTOR, readRow, readPage, nativeRoot, filterLists, filterForm, accessibleName };
});
