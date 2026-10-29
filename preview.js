(function exposePreview(root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.GitHubSubscriptions;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GitHubSubscriptionPreview = api;
})(globalThis, function createPreviewApi(core) {
  "use strict";

  const BODY_SELECTOR = ".js-comment-body, .comment-body, [data-testid='comment-body'], [data-testid='markdown-body'], .markdown-body, .markdown-body-short";
  // GitHub server-renders comment composers and edit forms with a markdown preview pane that reuses
  // the .comment-body/.markdown-body classes and contains the placeholder "Nothing to preview".
  const COMPOSER_PREVIEW_SELECTOR = ".js-preview-body, .js-preview-panel, .preview-content";
  const PLACEHOLDER_TEXT = /^(?:nothing to preview|loading preview(?:…|\.{3})?)$/i;
  const LIMIT = 12000;

  function isComposerPreview(node) {
    return Boolean(node.closest?.(COMPOSER_PREVIEW_SELECTOR));
  }

  function contentBodies(nodes) {
    const candidates = nodes.filter((node) => !isComposerPreview(node));
    return candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)));
  }

  function cleanBodyNode(node) {
    const body = node.cloneNode(true);
    body.querySelectorAll(`script, style, template, noscript, iframe, object, form, button, input, svg, ${COMPOSER_PREVIEW_SELECTOR}`).forEach((child) => child.remove());
    body.querySelectorAll("br").forEach((child) => child.replaceWith("\n"));
    body.querySelectorAll("p, div, pre, blockquote, li, h1, h2, h3, h4, h5, h6, tr").forEach((child) => child.append("\n"));
    body.querySelectorAll("img").forEach((child) => child.replaceWith(child.alt ? `[Image: ${child.alt}]` : "[Image]"));
    const text = (body.textContent || "").replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
    return PLACEHOLDER_TEXT.test(text) ? "" : text;
  }

  function cleanHtmlFragment(html, document) {
    if (typeof html !== "string" || !html.trim()) return "";
    const wrapper = (document || globalThis.document)?.createElement?.("div");
    if (!wrapper) return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    wrapper.innerHTML = html;
    return cleanBodyNode(wrapper);
  }

  function extractEmbeddedEntries(document) {
    const comments = [];
    const descriptions = [];
    const seen = new Set();
    const scripts = typeof document.querySelectorAll === "function" ?
      [...document.querySelectorAll("script[data-target='react-app.embeddedData'], script[data-target='react-partial.embeddedData'], script[type='application/json']")] : [];

    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const rawText = typeof node.body === "string" && node.body.trim() ? node.body.trim() :
        typeof node.bodyText === "string" && node.bodyText.trim() ? node.bodyText.trim() :
        typeof node.bodyHTML === "string" ? cleanHtmlFragment(node.bodyHTML, document) :
        typeof node.bodyHtml === "string" ? cleanHtmlFragment(node.bodyHtml, document) : "";
      const author = core.cleanText(
        node.author?.login || node.author?.name || node.authorLogin || node.user?.login || "",
        100
      );
      const rawDate = node.createdAt || node.updatedAt || node.publishedAt || "";
      const dateTime = typeof rawDate === "string" && Number.isFinite(Date.parse(rawDate)) ? rawDate : "";
      const dbId = node.databaseId != null ? String(node.databaseId) : "";
      const url = typeof node.url === "string" ? node.url : typeof node.permalink === "string" ? node.permalink : "";
      const isIssueOrPr = typeof node.title === "string" && (typeof node.number === "number" || typeof node.state === "string");

      if (rawText) {
        const signature = `${dbId}|${author}|${dateTime}|${rawText.slice(0, 120)}`;
        if (!seen.has(signature)) {
          seen.add(signature);
          const entry = { dbId, url, text: rawText, author, dateTime, title: typeof node.title === "string" ? node.title : "" };
          if (isIssueOrPr) descriptions.push(entry);
          else comments.push(entry);
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    }

    for (const script of scripts) {
      const content = script.textContent;
      if (!content || content.length > 5 * 1024 * 1024) continue;
      try {
        visit(JSON.parse(content));
      } catch {
        // Ignore non-JSON or unrelated script blocks.
      }
    }
    return { comments, descriptions };
  }

  function formatSlice(text) {
    return {
      text: text.slice(0, LIMIT),
      truncated: text.length > LIMIT
    };
  }

  function readFallbackContent(document, target) {
    const targetDigits = /(\d+)$/.exec(target?.id || "")?.[1] || "";
    const { comments, descriptions } = extractEmbeddedEntries(document);
    if (targetDigits) {
      const exact = comments.find((entry) =>
        entry.dbId === targetDigits ||
        (entry.url && entry.url.endsWith(`#${target.id}`)) ||
        (entry.url && entry.url.endsWith(`-${targetDigits}`))
      );
      if (exact) {
        return {
          ...formatSlice(exact.text),
          author: exact.author,
          dateTime: exact.dateTime
        };
      }
    }

    if (descriptions.length || comments.length) {
      const opening = descriptions[0];
      const recentComments = comments.slice(-3);
      const mentionComments = comments.slice(0, -3).filter((entry) => /@[a-z\d-]+/i.test(entry.text)).slice(-2);
      const selectedComments = [...mentionComments, ...recentComments];
      const sections = [];
      if (opening) {
        const openingLabel = opening.author ? `Issue/PR description (@${opening.author.replace(/^@/, "")})` : "Issue/PR description";
        sections.push(`${openingLabel}:\n${opening.text.slice(0, 3500)}`);
      }
      for (let i = 0; i < selectedComments.length; i++) {
        const entry = selectedComments[i];
        if (opening && selectedComments.length === 1 && entry.text === opening.text) continue;
        const isLast = i === selectedComments.length - 1;
        const label = isLast ? "Latest comment" : "Earlier comment";
        const authorTag = entry.author ? ` (@${entry.author.replace(/^@/, "")})` : "";
        sections.push(`${label}${authorTag}:\n${entry.text.slice(0, 3000)}`);
      }
      const chosen = selectedComments.at(-1) || opening;
      return {
        ...formatSlice(sections.join("\n\n") || chosen.text),
        author: chosen.author || opening?.author || "",
        dateTime: chosen.dateTime || opening?.dateTime || ""
      };
    }

    if (typeof document.querySelectorAll !== "function") return null;
    const topBodies = contentBodies([...document.querySelectorAll(BODY_SELECTOR)]);
    const parsedBodies = [];
    for (const bodyNode of topBodies) {
      const text = cleanBodyNode(bodyNode);
      if (!text) continue;
      const wrapper = bodyNode.closest?.(".timeline-comment, .react-issue-comment, .js-timeline-item, .border-top, .Box, article, section, div") || bodyNode.parentElement;
      const authorNode = wrapper?.querySelector?.("a.author, [data-testid='comment-header'] a[data-testid='avatar-link'], [data-testid='comment-author'], .author, span.text-bold");
      const timeNode = wrapper?.querySelector?.("relative-time[datetime], time[datetime]");
      const rawDate = timeNode?.getAttribute?.("datetime") || "";
      parsedBodies.push({
        text,
        author: core.cleanText(authorNode?.textContent || authorNode?.getAttribute?.("aria-label"), 100),
        dateTime: Number.isFinite(Date.parse(rawDate)) ? rawDate : ""
      });
    }
    if (parsedBodies.length) {
      const first = parsedBodies[0];
      const tail = parsedBodies.slice(1);
      const recentTail = tail.slice(-3);
      const mentionTail = tail.slice(0, -3).filter((entry) => /@[a-z\d-]+/i.test(entry.text)).slice(-2);
      const selectedTail = [...mentionTail, ...recentTail];
      const sections = [
        first.author ? `Opening post (@${first.author.replace(/^@/, "")}):\n${first.text.slice(0, 3500)}` : `Opening post:\n${first.text.slice(0, 3500)}`
      ];
      for (let i = 0; i < selectedTail.length; i++) {
        const entry = selectedTail[i];
        if (entry.text === first.text) continue;
        const label = i === selectedTail.length - 1 ? "Latest update" : "Earlier comment";
        const authorTag = entry.author ? ` (@${entry.author.replace(/^@/, "")})` : "";
        sections.push(`${label}${authorTag}:\n${entry.text.slice(0, 3000)}`);
      }
      const last = parsedBodies.at(-1);
      return {
        ...formatSlice(sections.length > 1 ? sections.join("\n\n") : last.text),
        author: last.author || first.author,
        dateTime: last.dateTime || first.dateTime
      };
    }

    const mainNode = document.querySelector?.("main, [role='main']");
    if (mainNode) {
      const clone = mainNode.cloneNode(true);
      clone.querySelectorAll?.(".gh-header, h1, nav, header").forEach((node) => node.remove());
      const mainText = cleanBodyNode(clone) || cleanBodyNode(mainNode);
      if (mainText) {
        const authorNode = mainNode.querySelector?.("a.author, [data-testid='comment-author'], .author");
        const timeNode = mainNode.querySelector?.("relative-time[datetime], time[datetime]");
        const rawDate = timeNode?.getAttribute?.("datetime") || "";
        return {
          ...formatSlice(mainText),
          author: core.cleanText(authorNode?.textContent || authorNode?.getAttribute?.("aria-label"), 100),
          dateTime: Number.isFinite(Date.parse(rawDate)) ? rawDate : ""
        };
      }
    }
    return null;
  }

  function readComment(document, target, { allowFallback = false } = {}) {
    if (document.querySelector("form[action='/session'] input[type='password'], #login_field")) {
      throw new Error("GitHub is asking you to sign in. Open the item, sign in, then retry the preview.");
    }
    const anchor = target?.id && target.id !== "thread" ? (
      document.getElementById(target.id) ||
      [...document.querySelectorAll("a[name]")].find((node) => node.getAttribute("name") === target.id)
    ) : null;
    if (anchor) {
      let container = anchor;
      for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
        if (container.matches("body, main, [role='main'], .js-discussion, .js-discussion-timeline")) break;
        const bodies = contentBodies(container.matches(BODY_SELECTOR) ? [container] : [...container.querySelectorAll(BODY_SELECTOR)]);
        if (bodies.length > 1) {
          if (!allowFallback) return null;
          break;
        }
        if (!bodies.length) continue;
        const text = cleanBodyNode(bodies[0]);
        if (!text) break;
        const author = container.querySelector("a.author, [data-testid='comment-header'] a[data-testid='avatar-link'], [data-testid='comment-author']");
        const time = container.querySelector("relative-time[datetime], time[datetime]");
        const dateTime = time?.getAttribute("datetime") || "";
        return {
          ...formatSlice(text),
          author: core.cleanText(author?.textContent || author?.getAttribute("aria-label"), 100),
          dateTime: Number.isFinite(Date.parse(dateTime)) ? dateTime : ""
        };
      }
    }
    if (!allowFallback) return null;
    return readFallbackContent(document, target);
  }

  async function load(target, { signal, fetchPage = fetch, parse = (html) => new DOMParser().parseFromString(html, "text/html"), allowFallback = false } = {}) {
    const item = core.parseItem(target?.url);
    const checkTarget = allowFallback ? (core.summaryTarget || core.commentTarget) : core.commentTarget;
    if (!item || item.url !== target.url || item.key !== target.key ||
        checkTarget(`${target.url}#${target.id}`)?.id !== target.id) {
      throw new Error("This notification does not have a supported comment link.");
    }
    const response = await fetchPage(target.url, {
      method: "GET",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "text/html" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
    });
    if (!response.ok) {
      throw new Error(response.status === 429 ? "GitHub rate-limited this preview. Wait a minute, then retry." :
        `GitHub could not load the linked comment (HTTP ${response.status}). Open the item or retry.`);
    }
    if (!response.headers.get("content-type")?.includes("text/html")) {
      throw new Error("GitHub did not return an item page. Open the item or retry the preview.");
    }
    const html = await response.text();
    signal.throwIfAborted();
    return readComment(parse(html), target, { allowFallback });
  }

  return { readComment, load };
});
