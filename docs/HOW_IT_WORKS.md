# How Signalbox Works

This document covers the architecture, filtering behavior, local AI summarization pipeline, caching, and privacy guarantees of **Signalbox**.

---

## 1. Priority Filter (`#priority`) & Scoring

Signalbox adds a **Priority** view (`https://github.com/notifications#priority` or `priority:only`) that scores every inbox notification on a **0–100 scale** (`PRIORITY_THRESHOLD = 42`):

- **Direct Ask & Signal (0–45 pts):**
  - Explicit `assigned`, `review-requested`, or direct `@mention` reasons, or a 5-head local **Kev** triage score (`http://127.0.0.1:8009/v1/systemone` evaluating `direct_ask`, `blocker_or_decision`, `resolved_or_stale`, `response`, and `urgency`).
  - Title/subject keywords indicating blockers, approvals, or incidents.
- **Organizational Hierarchy & Core Repositories (0–30 pts):**
  - Matches notification participants against your local `contacts` rules (`points` per person/tier, plus a `+5` convergence bonus when multiple tracked contacts participate on the same thread).
  - Boosts notifications in your `coreRepos` (`+12`) and `adjacentRepos` (`+6`).
- **Bimodal 72-Hour SLA & Recency Curve (0–25 pts):**
  - Fresh updates (`<4h`) and unanswered open asks approaching the 24–72h SLA window receive top recency weight.
  - Stale threads (`>14 days`) are damped by `×0.6`.
  - Closed or merged issues/PRs are damped by `×0.45`.

### 4-Hour Pinned Workday Snapshot
Once Priority finishes scanning, Signalbox locks the resulting item list and order for **4 hours** (and resets automatically the next calendar day or when you click **Refresh**). Clicking into an issue and navigating back will never reshuffle your list mid-triage.

### One-Click Quick Sweep (`Read & Done`)
At the top of **Priority** and **Subscriptions**, Signalbox groups noisy threads into one-click sweep pills (**`Review requested`**, **`Team mentioned`**, **`Stale participating`**, and **`Sweep all noise`**) that archive matching threads in batch via GitHub's native `/notifications/beta/archive` form tokens.

---

## 2. Subscriptions Filter (`#subscriptions`)

- **Add items from anywhere on GitHub:**
  - Click **Add to subscriptions** in an issue, PR, or discussion header.
  - Click the bookmark icon on any notification row.
  - Paste one or more URLs or `owner/repo#123` shorthands into the toolbar popup (`manager.html`).
- **Supported targets:** Issues, pull requests, discussions, releases (`/releases/tag/...`), and full 40-character commit SHAs. Comments, query strings, and PR sub-tabs (`/files`, `/commits`) normalize to the parent item.
- **All-page inbox scan:** Scans read and unread notifications across all inbox pages (and expands repository-grouped `View all notifications` links) using sequential same-origin requests. Supports **Pause / Continue**, **Refresh**, and **Retry** without presenting an incomplete scan as complete.

---

## 3. Multi-Stage Thread Extraction & Previews

When you click **Preview linked comment** or **Summarize**, Signalbox fetches the target thread using a same-origin GET request (with notification tracking parameters stripped and no referrer):

1. **Exact linked comment:** Extracts the specific `#issuecomment-`, `#discussioncomment-`, `#pullrequestreview-`, or `#r...` fragment when present in the HTML.
2. **React `embeddedData` & thread fallback:** When GitHub serves modern React `IssueViewer` markup or a notification URL has no `#issuecomment-` anchor, Signalbox parses `script[data-target="react-app.embeddedData"]` (or page DOM) to extract:
   - The opening issue/PR description (capped at 3,500 characters)
   - Earlier comments that `@mention` you directly
   - The latest 3 timeline comments
3. **Plain-text safety:** All previews and summaries are rendered strictly via `textContent` (never `innerHTML`). Long sources are capped at 12,000 characters and badged with a compact **`Partial`** pill.

> **Note on read state:** Fetching an item page on GitHub using your active session may mark that notification as read on GitHub. Signalbox warns before fetching and never calls Mark Read, Done, Subscribe, or Unsubscribe APIs unless you explicitly click a Quick Sweep button.

---

## 4. Local AI Summarization Pipeline

Summaries run 100% locally against fixed loopback endpoints (defaulting to **Splash**):
- **Splash:** `http://127.0.0.1:8000`
- **Ollama:** `http://127.0.0.1:11434`
- **LM Studio:** `http://127.0.0.1:1234`
- **Local MLX Server:** `http://127.0.0.1:8080`
- **Local Kev Triage (optional):** `http://127.0.0.1:8009`

### Splash Setup
Install [Splash](https://github.com/incoai/splash) separately. In `chrome://extensions`, enable Developer mode, copy Signalbox's extension ID, and start Splash with that exact extension origin allowed (replace `YOUR_EXTENSION_ID`):

```bash
HF_HOME="$HOME/Models/huggingface" splash serve \
  --model mlx-community/Qwen3.8-27B-4bit \
  --host 127.0.0.1 --port 8000 \
  --allowed-origin chrome-extension://YOUR_EXTENSION_ID
```

Allow only the exact extension origin, not `*`. If Ollama reports HTTP 403, allow the exact `chrome-extension://<extension-id>` origin through `OLLAMA_ORIGINS` and restart Ollama.

### Key Behaviors
- **Works on every filter view:** Injects **Summarize comments** and per-row **Summarize** controls on native GitHub views (`Inbox`, `Unread`, `Assigned`, `Mentioned`, `Participating`, `Review requested`, custom filters) as well as **Priority** and **Subscriptions**.
- **Context-window parallel scheduling:** Queries the active model's context window (`contextWindowForModel`), estimates per-notification token usage (`estimateTokens`), and schedules concurrent summary jobs up to the token budget—prioritizing higher-scoring notifications first.
- **Second-person actionable output:** Addresses the signed-in user (`meta[name="user-login"]`) as `"you"` and classifies every row into:
  - **`Needs your response`** — requires an exact `@username` mention from a different author, paired with a verbatim quote under **Why this may need you**.
  - **`FYI`** — informational update or a request directed at someone else.
  - **`Unclear ask`** — open question without a clear recipient.

---

## 5. Local Caught-Up State & Snapshot Reuse

- **Caught up, locally:** Clicking **Caught up** hides an observed update locally without changing GitHub's read/Done state. Scoped per signed-in GitHub username; if a thread gets a newer timestamp, linked comment, or state change, it automatically resurfaces on the next scan.
- **SHA-256 snapshot reuse:** Up to 200 summaries are cached in `chrome.storage.local` for 30 days. Reopening a cached summary never fetches GitHub or calls the model. Clicking **Recheck comment** computes a SHA-256 digest over the source text, title, author, timestamp, account, model, and prompt version—reusing the summary if unchanged or regenerating if edited.

---

## 6. Storage & Privacy

- All data (`chrome.storage.local`) stays in your local Chrome profile: saved item URLs, priority rules, model selection, caught-up markers, and bounded summaries. Full source comments stay in memory only and are never persisted.
- Zero analytics, zero cloud API calls, zero GitHub API tokens. Loopback requests reject redirects and never forward GitHub cookies.
