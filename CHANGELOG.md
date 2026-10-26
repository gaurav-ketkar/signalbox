# Changelog

All notable user-facing improvements to **Signalbox** are documented in this file.
This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

---

## [1.6.0] - 2026-10-26

### Added
- **Cloud & GitHub Copilot Providers:** Added optional support for **GitHub Copilot** (`api.githubcopilot.com`, supporting both `/chat/completions` and `/responses` models plus `copilot:auto`), **OpenAI** (`api.openai.com`), **Anthropic** (`api.anthropic.com`), and **Google Gemini** (`generativelanguage.googleapis.com`) alongside local engines (**Splash**, **Local MLX**, **LM Studio**, and **Ollama**).
- **Two-Slot Hybrid Model Routing:** Configure **Row summaries** (`Inbox`, `Priority`, `Subscriptions`) and **Today's Executive Briefing (`#today`)** independently—for example, keeping bulk row summaries on a `$0` local model while routing the once-a-day `#today` synthesis (~1,000 tokens/day) to a frontier model (`copilot:claude-opus-5.5` or `gemini-2.5-pro`).
- **Near-Zero-Cost Controls (`Manual row clicks only`):** Added a one-click toggle that hides bulk `Summarize comments` and disables automatic on-load summarization so cloud tokens are only spent when you explicitly click `Summarize` on a specific row.
- **Automatic Cloud-to-Local Fallback with UI Warnings:** If a selected cloud model is unavailable or rate-limited, Signalbox automatically falls back to the next available Copilot/cloud model and then to your local engine (`Splash :8000` / `MLX :8080`)—displaying an amber **`Local fallback`** warning pill so you never get stuck without a summary.

### Changed
- **Redesigned Settings & List Manager (`manager.html`):** Reorganized the settings page into a two-column top workspace (**Add GitHub links** beside **Your list**), side-by-side **Row summaries** and **Today's Executive Briefing** cards, and a compact **Local cache & review state** bar.

![Signalbox v1.6.0 Two-Slot Model Routing & Manager](docs/changelog/v1.6-manager-routing.png)

---

## [1.5.0] - 2026-10-23

### Added
- **Experimental `Today` View (`#today`) with Morning Executive Briefing:** Filters your inbox to **P1 Priority** notifications (`score >= 70`), automatically summarizes un-summarized P1 threads, and synthesizes a single-paragraph ($\le$250-word) executive briefing above the P1 rows—crafted around Joel Schwartzberg's *Get to the Point* and Paul Graham's *Write Like You Talk* / *How to Write Usefully*.
- **Full-Day Briefing Persistence:** Once generated, Today's briefing is saved for the rest of the calendar day (`today-briefing:v1:<viewer>`) so revisiting **Today** is instant unless you click **Regenerate briefing**.
- **Automatic Unread Restoration (`/notifications/beta/unmark`):** Summarizing or previewing an unread notification immediately restores its unread state on GitHub so unread threads stay unread until you actually open them.

### Changed
- **Top-of-Sidebar Filter Placement:** Moved **Today**, **Priority**, and **Subscriptions** to the top of GitHub's **Filters** sidebar list.
- **Zero-Jump Native `Done` Handling:** Preloaded cached summaries into RAM and tracked per-tab check state so GitHub's DOM swap after clicking **Done** never re-runs inference or shifts row layout.

![Signalbox v1.5.0 Today Morning Executive Briefing](docs/changelog/v1.5-today-briefing.png)

---

## [1.4.0] - 2026-10-22

### Added
- **Splash Local Engine Default (`127.0.0.1:8000`):** Added [Splash](https://github.com/incoai/splash) as the default local inference server while preserving existing saved provider selections.
- **Priority-Ordered Summary Scheduling:** Batch summarization starts the highest-scoring Priority notifications first while running in parallel up to the model's context window token budget.

---

## [1.3.0] - 2026-10-20

### Added
- **Smart `Priority` View (`#priority`) with 4-Hour Pinned Snapshot:** Scores notifications (0–100) using direct asks/mentions, organizational hierarchy & core repository rules (`priority-config.local.json` / settings UI), a 72-hour bimodal SLA recency curve, and optional local **Kev-4B** (`127.0.0.1:8009/v1/systemone`) triage. Locks the Priority list order for 4 hours so clicking into issues and navigating back never reshuffles your list.
- **Inline AI Summaries on *Every* GitHub Filter View:** Added **Summarize comments** and per-row **Summarize** to native GitHub views (`Inbox`, `Mentioned`, `Assigned`, `Participating`, `Review requested`, custom filters) in addition to **Priority** and **Subscriptions**.
- **One-Click Quick Sweep (`Read & Done`):** Batch-archive noisy `Review requested`, `Team mentioned`, and `Stale participating` threads directly from the header.
- **Multi-Stage Thread Fallback Extraction:** Extracts React `embeddedData` JSON, opening issue/PR descriptions, earlier `@mention` comments, and the latest 3 timeline comments when a notification has no `#issuecomment-` anchor.

![Signalbox v1.3.0 Priority Triage & Quick Sweep](docs/changelog/v1.3-priority-triage.png)

![Signalbox v1.3.0 Native Filter View Summaries](docs/changelog/v1.3-native-summaries.png)
