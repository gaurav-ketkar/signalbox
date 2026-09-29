---
date: 2026-09-25
type: project
tags: [chrome-extension, github, notifications]
people: []
projects: [signalbox]
---

# Signalbox

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Add a "Subscriptions" filter to GitHub's notifications page. Show notifications
only for issues, pull requests, discussions, and other supported items that the
user explicitly adds to a local list.

## Users and Operating Context

People using github.com in desktop Chrome who want a short, deliberate list
instead of treating every GitHub notification as equally important.

## Capabilities and Constraints

- Add an item from its GitHub page, a notification row, or a pasted link.
- Read GitHub's notification HTML and follow its pagination.
- Keep subscriptions in this Chrome profile. No token, cloud backend, or analytics.
- Keep GitHub's own notification settings unchanged. Do not automatically
  change notification state; warn that opening an item or a preview may mark it read.
- Create or name the local filter through GitHub's native add-filter dialog.
- Preserve notification reasons and context. Preview an exact linked comment
  on request when GitHub includes it in the item page.
- Summarize that exact comment with an installed local LM Studio, Ollama, or MLX model across all GitHub notification filter views (not just Subscriptions). Keep
  summaries beside the notification, not behind the preview.
- Schedule local summaries in parallel up to the active model's context window token budget.
- Distinguish explicit requests to the signed-in user from FYI and unclear recipients.
- Mark observed updates caught up locally without changing GitHub's state.
- Keep matching summaries across visits and reuse inference until its source changes.
- Work directly from this folder as an unpacked Manifest V3 extension.

## Implementation Decisions

The user requested an implementation without questions. These are implementation
choices, not additional user requirements:

- Match GitHub's existing interface and light/dark themes.
- Use aligned item, activity, and time/control columns when the inbox is wide.
  Give summaries and previews more space than item details. Stack the same
  groups in reading and keyboard order when the inbox is narrow.
- Search the inbox, including read and unread notifications, across pages.
  Completed notifications remain in GitHub's Done view.
- Use a separate read-only result list so native bulk actions cannot target
  hidden rows.
- Support issues, pull requests, repository discussions, releases, and commits.
- Offer a full-page list manager and the same manager in the toolbar popup.
- Put the shortcut in the actual Filters list, never the global breadcrumbs.
- Store one named local filter. Do not send its `subscriptions:only` query to
  GitHub or interfere with ordinary native filters.
- Show participants as participants, not as inferred triggering authors.
- Fetch comment previews only after expansion. Keep the original notification
  link and never substitute a newer comment for a missing linked comment.
- Render previews as text, with no scripts, remote images, or stored comment content.
- Use only the two fixed loopback LM Studio/Ollama endpoints. Do not send GitHub content to
  cloud models, download models, or forward GitHub cookies to the model server.
- Keep automatic summaries off until explicitly enabled. Warn that fetching
  source comments may mark notifications read, and check model availability first
  for new summaries. Saved snapshots and unchanged-source rechecks work offline.
- Limit summaries to a short explanation and an explicit request when present.
  Label AI output, retain the original, and never substitute another comment.
- Name the actual author and recipients, use active voice, preserve uncertainty,
  and require verbatim evidence with an exact @mention for a direct request.
  One comment cannot establish whether another reply already answered it.
- Queue model work across tabs and support cancellation. Keep full source comments
  in memory, but persist bounded summaries and short evidence quotes in local storage.
- Isolate summaries and caught-up state by GitHub's signed-in username. Do not
  infer it from participants or enable caught-up marking without an update time.
- Default to hiding caught-up updates; provide show and undo controls. Detect
  new activity on inbox scans/refresh, not background polling.
- Label saved snapshots with source-check time. Recheck exact source fingerprints;
  never silently reuse a changed notification's assessment.
- Keep at most 200 saved summaries with a 30-day reuse limit. Let users clear
  summaries or reset caught-up markers without changing subscriptions or model
  settings. Link exports contain neither summaries nor account-specific data.

## Product Principles

Explicit choices only. Keep data local. Do not silently claim a search is
complete when a request fails or GitHub's page cannot be recognized.
