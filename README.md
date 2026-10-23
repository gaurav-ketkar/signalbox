# Signalbox

> **Turn GitHub's notification firehose into pure signal—100% locally on your Mac.**

Signalbox is an unpacked Chrome extension that adds **Priority** and **Subscriptions** views to GitHub notifications, summarizes threads inline across *every* filter view using local AI (Splash, Apple MLX, LM Studio, or Ollama), and sweeps noisy notifications in one click.

No GitHub token, cloud API key, or build step required.

![Demo of Signalbox](docs/demo.gif)

*([Watch the 19-second full-resolution MP4 demo with voice-over](docs/demo.mp4))*

## Highlights

- **Morning Executive Briefing in `Today` (`#today`):** Automatically summarizes your **P1 Priority** notifications and synthesizes a single-paragraph (<250-word) morning executive briefing right above the P1 threads—crafted around Joel Schwartzberg's *Get to the Point* and Paul Graham's *Write Like You Talk* / *How to Write Usefully*.
- **Inline AI summaries on every filter view (without losing unread state):** Works in `Inbox`, `Mentioned`, `Assigned`, `Participating`, custom filters, **Today**, **Priority**, and **Subscriptions**. Unread notifications that get summarized are automatically restored to unread (`POST /notifications/beta/unmark`) right after their source page is fetched. Every summary addresses you in the second person, leads with a status pill (**`Needs your response`**, **`FYI`**, or **`Unclear ask`**), and cites a verbatim quote when you're mentioned.
- **Smart `Priority` view (`#priority`):** Ranks notifications (0–100) by direct asks, your team/repo rules, and a 72-hour SLA recency curve. Pins the list for 4 hours so rows never jump around while you work through them.
- **Deliberate `Subscriptions` view (`#subscriptions`):** Bookmark specific issues, PRs, discussions, releases, or commits from anywhere on GitHub and track them in one calm view across all inbox pages.
- **Multi-stage thread extraction:** Pulls the exact linked comment or falls back to the issue/PR description, earlier `@mention` comments, and the last 3 timeline updates from GitHub's embedded JSON.
- **Context-window parallel local AI:** Schedules concurrent summaries up to your local model's token budget (Splash `:8000`, Local MLX `:8080`, LM Studio `:1234`, Ollama `:11434`, plus optional Kev triage on `:8009`), ordered by Priority score.
- **One-click Quick Sweep (`Read & Done`):** Batch-archive `Review requested`, `Team mentioned`, and `Stale participating` noise directly from the header.

## Install

1. Clone this repo:
   ```bash
   git clone https://github.com/gaurav-ketkar/signalbox.git
   ```
2. Open `chrome://extensions` in Chrome (120+) and enable **Developer mode**.
3. Click **Load unpacked** and select the `signalbox` folder.
4. Pin **Signalbox** in Chrome's toolbar and refresh your open GitHub tabs.

## Quick Setup

### 1. Connect a Local Model
1. Click the **Signalbox** toolbar icon $\rightarrow$ **Manage list** (or click **Set up local summaries** on `github.com/notifications`).
2. Pick your **Local server** (**Splash**, **Local MLX**, **LM Studio**, or **Ollama**), click **Connect to local server**, select an installed model, and click **Save summary settings**.

### 2. Customize Priority Rules (Optional)
Open the extension's **Manage list** page (`manager.html`) and edit **Priority filter rules**—or create a gitignored `priority-config.local.json` in the repo root:

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

## Documentation & Development

- **[How Signalbox Works](docs/HOW_IT_WORKS.md)** — Deep dive into Priority scoring, Splash/MLX/Ollama setup, multi-stage comment extraction, SHA-256 summary caching, local `Caught up` state, and privacy guarantees.
- **[Contributing Guide](CONTRIBUTING.md)** — Design principles and privacy guardrails.

```bash
npm test              # Unit tests
npm run test:browser  # Playwright MV3 browser tests
```

## License

[Apache-2.0](LICENSE)
