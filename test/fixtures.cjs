const sha = "abcdef1234".repeat(4);
const pages = [
  [
    { href: "/acme/console/issues/11", title: "Tighten the release checklist", unread: true,
      reason: "assign", reasonTitle: "You were assigned to this issue", participants: ["maya", "sam"], icon: "octicon-issue-opened" },
    { href: "/acme/console/issues/110", title: "Background maintenance", unread: true },
    { href: "/acme/console/pull/42?notification_referrer_id=demo#issuecomment-123", title: "Keep keyboard focus after saving", unread: true,
      reason: "mention", reasonTitle: "You were mentioned", participants: ["ada"], icon: "octicon-git-merge" },
    { href: "/acme/console/discussions/11", title: "Same number, different conversation", unread: true },
    { href: "/other/console/issues/11", title: "A different repository", unread: false },
    { href: "/acme/console/actions/runs/987", title: "An unsupported notification type", unread: true }
  ],
  [
    { href: "/acme/console/discussions/73#discussioncomment-789", title: "How should weekly digests work?", unread: false,
      reason: "subscribed", participants: ["morgan"] },
    { href: "/acme/console/issues/999", title: "An unrelated issue", unread: false },
    { href: "/acme/console/pull/42", title: "Duplicate across changing pages", unread: false }
  ],
  [
    { href: "/acme/console/issues/84", title: "Make notification preferences easier to find", unread: true,
      reason: "team-mention", participants: ["jules"], icon: "octicon-issue-closed" },
    { href: `/acme/console/commit/${sha}`, title: "Keep the release notes current", unread: false },
    { href: "/acme/console/releases/tag/v2.0", title: "Version 2.0 is available", unread: true }
  ]
];
const subscriptions = [
  "https://github.com/acme/console/issues/11",
  "https://github.com/acme/console/issues/42",
  "https://github.com/acme/console/discussions/73",
  "https://github.com/acme/console/issues/84"
];

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function row(item, index = 0, modern = false) {
  return `<li ${modern ? 'data-testid="notification-list-item"' : 'class="notifications-list-item ' + (item.unread ? "notification-unread" : "notification-read") + '"'}
    data-notification-id="${index}" data-unread="${!!item.unread}">
    <label><input class="js-notification-bulk-action-check-item" type="checkbox" value="${index}" aria-label="Select notification"></label>
    <a class="notification-list-item-link" href="${escape(item.href)}">
      ${item.icon ? `<svg class="octicon ${escape(item.icon)}" aria-hidden="true" width="16" height="16"></svg>` : ""}
      <span class="markdown-title">${escape(item.title)}</span>
      <span class="fixture-meta">acme / console</span>
    </a>
    ${item.reason ? `<span ${modern ? 'data-testid="notification-reason"' : 'class="Label"'} title="${escape(item.reasonTitle || "")}">${escape(item.reason)}</span>` : ""}
    ${item.participants ? `<div class="AvatarStack-body">${item.participants.map((name) => `<a class="avatar" href="/${escape(name)}" aria-label="${escape(name)}">${escape(name)}</a>`).join("")}</div>` : ""}
    ${item.dateTime === "" ? "" : `<relative-time datetime="${escape(item.dateTime || "2026-09-25T18:00:00Z")}">2 hours ago</relative-time>`}
    <div class="notification-list-item-actions"><button title="Done" type="button">Done</button></div>
  </li>`;
}

const css = `
:root { --fgColor-default:#1f2328; --fgColor-muted:#59636e; --bgColor-default:#fff; --bgColor-muted:#f6f8fa; --borderColor-default:#d1d9e0; --fgColor-accent:#0969da; --fgColor-danger:#b62324; }
@media(prefers-color-scheme:dark) { :root { --fgColor-default:#f0f6fc; --fgColor-muted:#b1bac4; --bgColor-default:#0d1117; --bgColor-muted:#151b23; --borderColor-default:#3d444d; --fgColor-accent:#79c0ff; --fgColor-danger:#ff939a; } }
*{box-sizing:border-box}body{margin:0;background:var(--bgColor-default);color:var(--fgColor-default);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.fixture-banner{padding:16px 32px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default);color:var(--fgColor-muted)}
.Layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px;max-width:1240px;margin:32px auto;padding:0 28px}
nav ul{list-style:none;margin:0;padding:0}nav a{display:block;padding:8px 12px;color:inherit;text-decoration:none}nav .selected{background:var(--bgColor-muted);border-radius:6px;font-weight:600}
h1{font-size:24px;font-weight:600;margin:0 0 20px}h3{font-size:14px}.Box{border:1px solid var(--borderColor-default);border-radius:6px}
.Box-header{padding:12px;background:var(--bgColor-muted);display:flex;gap:12px;align-items:center}.notifications-list{margin:0;padding:0;list-style:none}
.notifications-list-item,[data-testid=notification-list-item]{display:flex;align-items:center;gap:12px;padding:16px;border-top:1px solid var(--borderColor-default)}
.notification-list-item-link{display:flex;flex:1;min-width:0;flex-direction:column;color:inherit;text-decoration:none}.markdown-title{font-weight:600}.fixture-meta,relative-time{font-size:12px;color:var(--fgColor-muted)}
button{font:inherit;border:1px solid var(--borderColor-default);border-radius:6px;padding:4px 8px;background:var(--bgColor-default);color:inherit}
.paginate-container{padding:20px;text-align:right}a{color:var(--fgColor-accent)}.blankslate{padding:40px;text-align:center}
.fixture-breadcrumbs{display:flex;gap:8px}.fixture-filters{margin-top:24px}.fixture-filters h2{font-size:12px;color:var(--fgColor-muted);margin:0 12px 8px}
dialog{width:800px;max-width:calc(100% - 32px);max-height:85vh;overflow:auto;padding:0;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-default);color:inherit}
dialog::backdrop{background:rgba(0,0,0,.35)}.fixture-dialog-header{display:flex;align-items:center;justify-content:space-between;padding:16px}
dialog ul{margin:0;padding:0;list-style:none}dialog li{padding:16px;border-top:1px solid var(--borderColor-default)}
.fixture-filter-form{display:flex;gap:8px}.fixture-filter-form input{min-width:0;flex:1;padding:6px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-default);color:inherit;font:inherit}
@media(max-width:600px){.fixture-filter-form{flex-wrap:wrap}.fixture-filter-form input{flex-basis:100%}}
@media(max-width:700px){.Layout{grid-template-columns:1fr;gap:20px;margin:20px auto;padding:0 16px}nav ul{display:flex;flex-wrap:wrap;gap:4px}.fixture-banner{padding:12px 16px}.notifications-list-item{flex-wrap:wrap}}
`;

function notifications({ page = 1, modern = false, next, rows, empty = false, groups = [], viewer = "you" } = {}) {
  const content = rows || (empty ? [] : pages[page - 1]);
  const nextHref = next === undefined ? (page < pages.length && !empty ? `?after=page-${page + 1}` : null) : next;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${viewer ? `<meta name="user-login" content="${escape(viewer)}">` : ""}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Notifications - synthetic test fixture</title><style>${css}</style></head><body>
    <div class="fixture-banner">GitHub notifications extension / Synthetic test fixture, not your account</div>
    <header><nav aria-label="Breadcrumbs" class="fixture-breadcrumbs"><a href="/notifications">Notifications</a></nav></header>
    <div class="Layout">
      <aside class="Layout-sidebar"><nav aria-label="Notifications"><ul>
        <li class="ActionListItem--navActive"><a class="selected" aria-current="page" href="/notifications">Inbox</a></li>
        <li><a href="/notifications?query=is%3Asaved">Saved</a></li>
        <li><a href="/notifications?query=is%3Adone">Done</a></li>
      </ul><section class="fixture-filters"><h2 id="fixture-filters-title">Filters</h2>
        <ul aria-labelledby="fixture-filters-title"><li><a href="/notifications?query=reason%3Amention">Mentioned</a></li></ul>
      </section><button type="button" aria-label="Customize filters" title="Add new filter" id="fixture-customize">Add new filter</button>
      </nav>
      <dialog id="fixture-filter-dialog" aria-labelledby="fixture-dialog-title">
        <div class="fixture-dialog-header"><h3 id="fixture-dialog-title">Filters</h3><button type="button" aria-label="Close dialog" id="fixture-close-filters">Close</button></div>
        <div class="fixture-dialog-header"><span>Name / Filter inbox by...</span><button type="button" id="fixture-new-filter">Create new filter</button></div>
        <ul id="fixture-custom-filter-rows"><li><form class="fixture-filter-form" action="/notifications/beta/update_custom_inbox" method="post">
          <input aria-label="Inbox name" name="custom_inbox[name]" value="Important" required>
          <input aria-label="Filter inbox by..." name="custom_inbox[query_string]" value="reason:mention" required>
          <button type="submit">Update</button>
        </form></li></ul>
      </dialog>
      <template id="fixture-new-filter-template"><li><form class="fixture-filter-form" action="/notifications/beta/create_custom_inbox" method="post">
        <input aria-label="Inbox name" name="custom_inbox[name]" required>
        <input aria-label="Filter inbox by..." name="custom_inbox[query_string]" required>
        <button type="submit">Create</button>
      </form></li></template>
      </aside>
      <main><h1>Notifications</h1>
        <div ${modern ? 'data-testid="notifications-list"' : 'class="js-check-all-container"'}><div class="Box">
          <div class="Box-header"><input class="js-notifications-mark-all-prompt" aria-label="Select all" type="checkbox"><button class="js-notifications-mark-all" type="button">Mark all as read</button></div>
          <section class="js-notifications-group"><ul class="notifications-list">${content.map((item, index) => row(item, page * 100 + index, modern)).join("")}</ul>
            ${groups.map((group) => `<div class="Box-footer js-notifications-group-view-all">${group.href ?
              `<a href="${escape(group.href)}">View all ${escape(group.count)} notifications</a>` :
              `<button type="button">View all ${escape(group.count)} notifications</button>`}</div>`).join("")}
          </section>
          ${!content.length ? '<div class="blankslate"><h2>All caught up!</h2><p>No notifications.</p></div>' : ""}
        </div></div>
        <div class="paginate-container">${nextHref ? `<a aria-label="Next" href="${escape(nextHref)}">Next</a>` : '<button disabled aria-label="Next">Next</button>'}</div>
      </main>
    </div>
    <script>
      window.fixtureWrites=0;window.fixtureNativeFilters=[];
      document.querySelectorAll(".js-notifications-mark-all,[title=Done]").forEach(button=>button.addEventListener("click",()=>window.fixtureWrites++));
      const dialog=document.getElementById("fixture-filter-dialog");
      document.getElementById("fixture-customize").addEventListener("click",()=>dialog.showModal());
      document.getElementById("fixture-close-filters").addEventListener("click",()=>dialog.close());
      document.getElementById("fixture-new-filter").addEventListener("click",()=>{
        document.getElementById("fixture-custom-filter-rows").append(document.getElementById("fixture-new-filter-template").content.cloneNode(true));
      });
      document.addEventListener("submit",event=>{
        event.preventDefault();
        window.fixtureWrites++;
        window.fixtureNativeFilters.push({action:event.target.getAttribute("action"),query:new FormData(event.target).get("custom_inbox[query_string]")});
      });
    </script>
  </body></html>`;
}

function itemPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A test GitHub item</title><style>${css}</style></head><body>
  <main style="max-width:960px;margin:32px auto;padding:20px"><div class="gh-header"><h1>Tighten the release checklist #11</h1></div><p>Synthetic issue body.</p></main>
  </body></html>`;
}

function commentPage({ id = "issuecomment-123", modern = false, missing = false, body, composer = false } = {}) {
  // Mirrors github/github app/views/comments/_preview_comment.html.erb, rendered in every edit and new-comment form.
  const previewPane = `<div class="preview-content"><div class="comment js-suggested-changes-container" data-thread-side="">
    <div class="comment-body markdown-body js-preview-body"><p>Nothing to preview</p></div></div></div>`;
  const editForm = composer ? `<form class="js-comment-update" action="/acme/console/issue_comments/1" method="post">
    <tab-container class="js-previewable-comment-form previewable-comment-form"><textarea name="issue_comment[body]">Saved text</textarea>${previewPane}</tab-container></form>` : "";
  const comment = (commentId, author, text) => `<div class="${modern ? "react-issue-comment" : "timeline-comment"}" id="${commentId}">
    <a class="author" href="/${author}">${author}</a><relative-time datetime="2026-09-25T17:30:00Z">Today</relative-time>
    <div ${modern ? 'data-testid="markdown-body"' : 'class="comment-body js-comment-body"'}>${text}</div>
    ${editForm}
  </div>`;
  const newCommentForm = composer ? `<form class="js-new-comment-form" action="/acme/console/issue_comments" method="post">
    <tab-container class="js-previewable-comment-form previewable-comment-form"><textarea name="comment[body]"></textarea>${previewPane}</tab-container></form>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Item with comments</title></head><body><main><div class="js-discussion-timeline">
    ${comment("issuecomment-122", "sam", "<p>An older, unrelated comment.</p>")}
    ${missing ? "" : comment(id, "ada", body || "<p>@you, could you review the keyboard fix?</p><p>Focus now returns to the Save button.</p>")}
    ${comment("issuecomment-124", "maya", "<p>A newer comment that did not trigger this notification.</p>")}
  </div>${newCommentForm}</main></body></html>`;
}

module.exports = { notifications, itemPage, commentPage, pages, subscriptions, row, sha };
