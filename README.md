# Signalbox

> **Turn GitHub's notification firehose into pure signal—100% locally on your Mac.**

Signalbox is a local Chrome extension that adds **Priority** and **Subscriptions** filters to GitHub's notifications sidebar, summarizes threads inline across every filter view using local AI (MLX, LM Studio, or Ollama), and lets you sweep noisy notifications in one click.

It reads GitHub's page HTML, including later pages. No GitHub token, cloud API key, or build step is needed.

![Demo of Signalbox](docs/demo.gif)

*([Watch the 19-second full-resolution MP4 demo with voice-over](docs/demo.mp4))*

## What makes this special

- **Inline AI summaries on *every* GitHub notifications view:** Works in `Inbox`, `Mentioned`, `Assigned`, `Participating`, `Saved`, custom filters, **Priority**, and **Subscriptions**. Each summary addresses you in the second person (`@maya-vp asked you to...`) and leads with a clear status pill (**`Needs your response`**, **`FYI`**, or **`Unclear ask`**) plus an inline **Show more / Show less** toggle when a summary wraps past 3 lines.
- **Multi-stage thread extraction (never "comment unavailable"):** Even when a notification lacks an `#issuecomment-` anchor or uses GitHub's modern React `IssueViewer`, the extension extracts the issue/PR description, earlier `@mention` comments, and the last 3 timeline updates from embedded JSON (`react-app.embeddedData`) or HTML so you get the full story without clicking through.
- **Smart `Priority` filter (`#priority`) with a pinned 4-hour workday snapshot:** Ranks notifications on a 0–100 scale combining **Direct Ask/Signal (0–45)**, **Organizational Hierarchy & Core Repos (0–30)**, and a **bimodal SLA/Recency curve (0–25)** (unanswered open asks stay hot across a 72h SLA window; stale threads >14d are damped `×0.6`; closed/merged threads are damped `×0.45`). Once scanned, the Priority list locks its order for 4 hours (and resets the next calendar day or on **Refresh**) so rows never jump or vanish as you click into issues and come back.
- **Context-window parallel scheduling + Kev-4B fast triage:** Dynamically queries the active local model's context window and runs summaries in parallel up to the token budget, ordered by Priority score. Optionally integrates with a local **Kev** decision model (`127.0.0.1:8009/v1/systemone`) to score `direct_ask`, `blocker_or_decision`, `resolved_or_stale`, and `urgency` in a single prefill pass.
- **One-click Quick Sweep (`Read & Done`):** Clear team-wide `Review requested`, `Team mentioned`, and `Stale participating` noise directly from the **Priority** or **Subscriptions** header without leaving your view.
- **Zero-layout-shift Primer CSS grid & synchronous memory cache:** High-specificity CSS grid tracks keep the middle summary column aligned to the exact same vertical scan edge across every row, and an in-memory summary cache repaints rows on the same frame when GitHub swaps list DOM nodes.
- **100% local & open-source friendly:** Zero cloud calls, zero telemetry, and zero hardcoded personal data—configure your own organizational contacts and core repositories in the extension's **Priority filter rules** settings (or via a gitignored `priority-config.local.json`). Backed by 105+ unit tests and a full Playwright Manifest V3 browser suite.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, then choose **Load unpacked**.
3. Select this repository folder:

   ```text
   /path/to/signalbox
   ```

4. Pin **Signalbox** from Chrome's extensions menu.
5. Refresh any GitHub tabs that were already open.

Chrome will request access to github.com and the loopback address `127.0.0.1`.
Content scripts run only on GitHub. Loopback access is used only for local AI
summaries, after you configure them. Chrome 120 or newer is required.

## Add subscriptions

Use whichever is most convenient:

- **On an item:** choose **Add to subscriptions** near the issue, pull request,
  or discussion header.
- **In your inbox:** choose the bookmark button next to a notification.
- **In the toolbar popup:** paste one or more GitHub links, then choose
  **Add subscriptions**. While visiting a GitHub item, **Add this page** is also
  available.

You can paste links separated by newlines or spaces. `owner/repo#123` works for
both issues and pull requests. Use the full URL for discussions because their
numbers are separate from issue and pull request numbers.

Examples:

```text
https://github.com/owner/repo/issues/123
https://github.com/owner/repo/pull/456
https://github.com/owner/repo/discussions/789
owner/repo#123
```

Comments, query strings, and PR tabs such as `/files` are normalized to the same
item. Duplicates are ignored. If any pasted entry is invalid, nothing in that
batch is added; the popup explains what to fix.

Releases (`/releases/tag/...`) and commits (`/commit/<full-40-character-SHA>`)
are also supported. Repository-wide subscriptions and wildcard matches are
deliberately not supported.

## Use the filter

Open [GitHub notifications](https://github.com/notifications). To create or name
the filter through GitHub's normal filter controls:

1. Choose **Add new filter** (the **Customize filters** button).
2. Choose **Create new filter**.
3. Choose **Use subscription list** in the new row.
4. Keep **Subscriptions** as the name, or enter your own name.
5. Choose **Create**. The extension saves the local filter and opens it.

After that, click its name under **Filters** whenever you want this view.
The **Subscriptions** shortcut is also available by default, including after
an update from version 1.0. Your existing saved items are kept.

The extension fills in `subscriptions:only` for you. This is an **extension-only
query**, not a GitHub search feature. Only that explicit query is handled locally;
ordinary GitHub filters still work normally. There is one local filter for the
subscription list. Creating it again changes its name rather than making a
duplicate. It is not saved to your GitHub account.

The **Subscription list filter** section of the same dialog lets you rename
or hide it. Hiding the filter does not delete your saved items.

The original bookmark still works, even if you rename or hide the shortcut:

```text
https://github.com/notifications#subscriptions
```

The extension checks the inbox across all pages, including read and unread
notifications. Matches appear as each page is checked; it does not stop after
the first page or after a page with no matches. It uses the full inbox rather
than inheriting a native search filter you were previously viewing.
For a repository-grouped inbox, it also follows each **View all notifications**
link and all pages inside that group. GitHub's grouping preference is not changed.

- **Pause / Continue** stops or resumes at the next page not yet checked.
- **Refresh** starts a fresh search, including a new first-page request.
- **Retry** resumes a request that failed. An incomplete search is never
  presented as a complete result.
- **Manage list** opens the saved list in a full tab.
- **View inbox** restores GitHub's normal list and controls.

The sidebar count is the number of **saved items**, not unread notifications.
The filtered result count is shown separately.

The inbox scan does not change notification state. Native checkboxes, bulk actions, and
original rows are hidden and made non-interactive while the filter is on.
Opening a matching link follows GitHub's normal behavior and may mark it read.

## Notification context and comment previews

Results keep the title, repository/item reference, read/unread state, timestamp,
and the original notification link. They also show GitHub's reason label,
participants, and item state when those are present in the notification HTML.
Participants are not presented as the person who triggered the notification.
A missing reason is labeled **Reason not provided by GitHub**, not guessed.

On wide inboxes, rows have three aligned columns: item details on the left,
the summary and comment preview in a wider middle column, and time, bookmark, and caught-up
controls on the right. Narrow inboxes stack these groups in the same reading
and keyboard order. Titles and context wrap rather than being cut off.

Choose **Preview linked comment** to load the comment referenced by that
notification. The preview includes its text, author, and time when available.
It does not fetch item pages until you expand a preview or request a summary.

- Only an exact linked issue, discussion, review, or commit-comment fragment
  is used. The extension never substitutes the latest comment.
- Deleted comments, comments loaded separately by GitHub, and notifications
  without a comment fragment get a clear explanation and an **Open notification
  on GitHub** link.
- Previews are plain text. Scripts, forms, embedded pages, and remote images
  are not inserted. Long comments are shortened at 12,000 characters and labeled.
- Preview failures have their own **Retry preview** action. They do not turn a
  successful inbox search into an error.
- Closing a pending preview, removing its subscription, or leaving the view
  cancels the request. If a summary also needs the same comment, closing its
  preview does not interrupt that summary. Loaded comments stay in memory until
  **Refresh** or navigation and are shared by previews and summaries.

**Loading a preview may mark the notification read on GitHub.** The extension
strips notification-tracking parameters and sends no referrer, but it still
requests the item page using your sign-in. The control warns about this before
you expand it. It never calls Mark read, Done, Subscribe, or Unsubscribe APIs.

## At-a-glance local AI summaries

Summaries use an installed **LM Studio**, **Ollama**, or **Local MLX** model on your machine. GitHub comments are
never sent to a cloud model, and the extension does not download models.
LM Studio uses `http://127.0.0.1:1234`, Ollama uses `http://127.0.0.1:11434`, and Local MLX uses `http://127.0.0.1:8080` (with optional fast triage via Kev on `http://127.0.0.1:8009`).
Only these fixed loopback endpoints are supported.

1. Choose **Set up local summaries** in the filtered inbox, or open the extension's
   list manager and find **Local AI summaries**.
2. Choose your **Local server**, then **Connect to local server**.
   Only installed local text models are listed.
   Cloud-backed and embedding models are excluded.
3. Choose a model and **Save summary settings**. LM Studio and MLX prefer an already
   loaded model. Ollama suggests `gemma4:12b-it-qat` when installed.
   Otherwise the smallest supported local model is selected.
4. Choose **Summarize comments** in Subscriptions or any GitHub notifications filter view to summarize the
   linked comments, or **Summarize** on one row.

Each summary names the people involved and uses short, active sentences. It
appears in the wider activity column with one of three local-AI labels:

- **Needs your response:** this comment makes an explicit request to your exact
  `@username`. **Why this may need you** shows a verbatim quote.
- **FYI:** information or a request clearly directed to someone else.
- **Recipient unclear:** the recipient or context is not clear enough to tell.

An explicit request is shown separately. Native reason labels remain unchanged;
a mention alone does not count as a request. Quoted, hypothetical, withdrawn, or
completed requests should not be treated as pending work. The model sees only
this linked comment, so **a later reply may already have answered it**. These
are suggestions, not a reliable task assignment. Expand the preview to check.

**Automatic summaries are off by default.** To turn them on, select
**Summarize automatically when I open Subscriptions** in AI settings and save.
Fetching the source comment pages **may mark those notifications read on GitHub**,
whether summaries are automatic or requested by hand. For a new summary, the
extension checks model availability before fetching its comment. A saved summary
can be reopened, or its unchanged source rechecked, without a running model.

- Summaries use only the exact linked comment. If the comment is missing or no
  supported comment link exists, the extension explains this instead of
  guessing from the title or substituting a newer comment. A linked comment is
  not proof of which event originally triggered the notification.
- Long source comments are limited to 12,000 characters. Both the model and
  the displayed summary are told when source text has been shortened.
- Generation runs in parallel up to the selected model's context window token budget. **Stop summaries** stops
  the current view's work. Leaving the view, removing an item, or changing model
  settings also cancels its pending work.
- A failure pauses the remaining summaries and shows **Retry summary** on the
  affected row. It does not invalidate a completed inbox scan.
- Full source comments stay in memory. Summaries and short evidence quotes are
  saved locally, separately for each signed-in GitHub account.
  **Turn off summaries** clears the model setting, not saved summaries or subscriptions.
- AI can miss details or misread a request. Review the original before acting.

If the local server is stopped, start it and retry. If the chosen model was removed, connect
again and choose an installed model. If Ollama reports HTTP 403, its origin policy
may need the extension's exact `chrome-extension://<extension-id>` origin allowed
through `OLLAMA_ORIGINS`; restart Ollama after changing that setting. Do not enable
all origins or expose Ollama to the public network.
There is no automatic switch to a different provider if a request fails.

## Caught up, locally

Choose **Caught up** after reviewing a row. It hides that observed update from
this view without fetching the item or changing GitHub's read, unread, or Done
state. **Undo caught up** reverses the last mark; **Show caught up (N)** lets you
revisit all matching rows you have reviewed.

Markers survive refresh and update other open GitHub tabs. They are scoped to
the signed-in username reported by GitHub. A newer notification time, different
linked comment, or changed title/item state makes the row appear again when
the inbox is scanned or refreshed. Read/unread state and reason changes do not.
There is no background inbox polling.

If GitHub does not expose the account or an update time, marking caught up is
disabled with an explanation. No account identity is guessed. Without an
account, manual summaries still work, but are not saved or labeled as a direct
request to you. Use **Reset caught-up state** in AI settings to clear all local
review markers without changing subscriptions or GitHub.

## Reuse summaries without hiding staleness

A matching saved snapshot appears without fetching GitHub or calling the model.
It says when the source was checked and that it has **not been rechecked this
visit**. Merely reopening a saved snapshot never marks a notification read.

Choose **Recheck comment** to fetch that exact source again. A SHA-256 digest
compares its text, title, author, time, partial-source flag, account, model, and
prompt version. Identical input reuses the summary; changed input requires a
new one. Missing sources discard the saved snapshot rather than substituting
another comment. Rechecking may mark the notification read on GitHub.

Changed notification activity does not silently restore the old assessment:
the source must be checked again first. Different comments, accounts, models,
or prompt versions also prevent snapshot reuse. Automatic mode rechecks visible
rows once per visit and skips caught-up rows. It remains off by default.

At most 200 summaries are kept across accounts. Snapshots older than 30 days
are not reused; expired entries are removed the next time a summary is saved.
**Clear saved summaries** removes them without changing your list, model, or
caught-up state, and stops current summary work. It does not immediately restart
automatic generation in open tabs. A later refresh can start it again.

## What this does not do

**Adding an item does not subscribe you to it on GitHub.** This list filters
notifications GitHub already sends you. If GitHub is not generating
notifications for an item, use its normal **Subscribe** or **Watch** controls.

Completed notifications stay in GitHub's **Done** view and are not part of the
inbox scan. The extension does not mark anything Done, unsubscribe you, or
change Watch settings.

GitHub can change its page structure. Known alternate layouts and navigation
updates are handled, but an unrecognized page produces a visible error instead
of silently claiming there are no notifications. Unsupported item types are
excluded and counted in a note below the results.

Repository renames, transferred issues, and links that redirect to another
repository may need an updated subscription URL.

## Storage and privacy

- Item URLs, save times, the local filter's name/visibility, and the local model
  name/automatic-summary preference live in
  `chrome.storage.local`, in this Chrome profile only. Local review markers
  and saved summaries also retain the account name, item identity, notification
  title/state/update time, source metadata and digest, model/prompt version,
  summary, explicit request, response label, and short evidence quote.
  Participants, native reasons, full comment text, and fetched pages are not saved.
- There is no analytics, cloud service, GitHub API token, or account credential
  storage. AI requests go only to the selected fixed loopback endpoint. Redirects
  are rejected, and GitHub cookies are never sent to the model server.
- While the filter is open, the extension makes sequential, same-origin GET
  requests to GitHub's notifications pages using your existing sign-in.
  Requests pause on errors and stop when you leave the filtered view.
- Expanding a preview or requesting a summary makes a same-origin GET request
  for that item. Only summaries send its plain-text comment, title, author,
  signed-in username, and a shortened-source flag to the local model. No other thread comments or
  GitHub account credentials are sent. Local model-server logging is controlled
  by that server, not the extension.
- The `activeTab` permission lets the toolbar popup offer **Add this page**
  after you open it. It does not grant general browsing-history access.
- The list is shared by GitHub tabs in this Chrome profile, not tied to a
  specific GitHub login, and is not synced to another computer. Summaries and
  caught-up markers are account-specific. Removing an item deletes its saved
  summaries and review markers for all accounts in this profile.

Use **Export links** to make a plain-text backup. Paste the exported links into
**Add GitHub links** to restore or merge them. Removing the extension from Chrome
also removes its local list, so export first.

## Updating

After editing these files, select **Reload** for the extension at
`chrome://extensions`, then refresh GitHub tabs. Do not move this folder after
loading it; Chrome keeps the original path.

## Tests

The runtime has no dependencies. Node.js is needed only for development tests:

```bash
cd signalbox
npm test
```

For the installed-extension browser tests:

```bash
npm ci --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local-browsers" npx playwright install chromium
npm run test:browser
```

The browser suite loads the actual Manifest V3 extension into a temporary
Chromium profile. Synthetic GitHub pages cover matching, all-page pagination,
cross-tab changes, persistence, native-control isolation, navigation, error
recovery, unrecognized markup, the native create-filter dialog, reason/state
metadata, exact-comment previews, safe text rendering, cancellation, and
local summary setup, generation, failures, cancellation, storage isolation, and
desktop/narrow/dark layouts. Local model responses are simulated in this suite. It does not
read your real GitHub inbox or use your normal Chrome profile.

To also exercise a real installed local model with synthetic comments:

```bash
npm run test:local
```

This separate test uses a temporary Chrome profile and checks the exact-comment
summary, named actors, explicit and ambiguous requests, other recipients, resolved
and quoted requests, partial sources, negation, a no-action update, and an instruction
embedded in source text. It defaults to LM Studio and needs a running server
and an installed local model; it does not install one. Set `GNS_LOCAL_MODEL` to
an Ollama model name, or `lmstudio:<model-key>` for an LM Studio model.

Screenshots are written to the ignored `test-results/` folder. Test profiles are
removed after the run.

## Configuring Priority Filter Rules

By default, the **Priority** filter (`https://github.com/notifications#priority`) scores notifications using direct asks/mentions, open/closed status, and a bimodal 72-hour SLA recency curve. To personalize scoring with your own organizational hierarchy and key repositories:

1. Open the extension's **Manage list** page (`manager.html`) and scroll to **Priority filter rules**, or
2. Create a gitignored `priority-config.local.json` in the repository root:

```json
{
  "contacts": {
    "octocat": { "tier": "Leadership", "role": "VP Engineering", "points": 18 },
    "hubot": { "tier": "Core peer", "role": "Staff Engineer", "points": 12 }
  },
  "coreRepos": ["acme/platform", "acme/console"],
  "adjacentRepos": ["acme/docs"]
}
```

## Contributing & License

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and privacy guardrails. Licensed under the [Apache-2.0 License](LICENSE).

