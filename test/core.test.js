const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");

test("normalizes GitHub issue links, comments, and repository case", () => {
  const item = core.parseItem(" https://github.com/Acme/Console/issues/123?notification_referrer_id=7#issuecomment-4 ");
  assert.equal(item.key, "acme/console#123");
  assert.equal(item.url, "https://github.com/acme/console/issues/123");
  assert.equal(item.label, "acme/console#123");
});

test("PR tabs and issue aliases share a key, but discussions do not", () => {
  const issue = core.parseItem("acme/console#42");
  for (const suffix of ["", "/files", "/commits", "/checks", "/files/abc"]) {
    const pr = core.parseItem(`https://github.com/acme/console/pull/42${suffix}`);
    assert.equal(pr.key, issue.key);
    assert.equal(pr.type, "pull");
  }
  assert.notEqual(core.parseItem("/acme/console/discussions/42").key, issue.key);
});

test("matches complete identifiers, not number or repository prefixes", () => {
  const target = core.parseItem("acme/console#1");
  for (const url of ["acme/console#10", "other/console#1", "acme/console-next#1"]) {
    assert.notEqual(core.parseItem(url).key, target.key);
  }
});

test("handles releases with case-sensitive tags and encoded slashes", () => {
  const release = core.parseItem("https://github.com/ACME/Console/releases/tag/Team%2Fv1.0");
  assert.equal(release.key, "acme/console/release/Team/v1.0");
  assert.equal(release.url, "https://github.com/acme/console/releases/tag/Team%2Fv1.0");
  assert.notEqual(release.key, core.parseItem("/acme/console/releases/tag/team/v1.0").key);
  assert.equal(core.parseItem("/acme/console/releases/tag/%XX"), null);
});

test("matches full commit SHAs without guessing from a short prefix", () => {
  const sha = "abcdef1234".repeat(4);
  const item = core.parseItem(`/Acme/Console/commit/${sha.toUpperCase()}#r1`);
  assert.equal(item.key, `acme/console/commit/${sha}`);
  assert.equal(core.parseItem(`/acme/console/commit/${sha.slice(0, 7)}`), null);
});

test("rejects unrelated pages, lookalike hosts, credentials, and unsafe URLs", () => {
  const invalid = [
    "", null, undefined, {}, "javascript:alert(1)", "http://github.com/acme/console/issues/1",
    "https://github.com.evil.test/acme/console/issues/1", "https://evil.test/github.com/acme/console/issues/1",
    "https://user:password@github.com/acme/console/issues/1", "https://github.com:444/acme/console/issues/1",
    "//github.com/acme/console/issues/1", "/notifications", "/acme/console", "/acme/console/issues",
    "/acme/console/issues/0", "/acme/console/issues/12x", "/acme/console/pull/42evil",
    "/acme/console/actions/runs/42", "/acme/console/releases", "/acme/console/discussions/categories/ideas",
    "https://github.com/acme%2Fevil/console/issues/1", "#42"
  ];
  for (const value of invalid) assert.equal(core.parseItem(value), null, String(value));
});

test("bulk parsing deduplicates aliases and reports every invalid entry", () => {
  const parsed = core.parseInput("acme/console#42\nhttps://github.com/Acme/Console/pull/42/files\nnope\n/acme/console/discussions/42");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.duplicates, 1);
  assert.deepEqual(parsed.invalid, ["nope"]);
  assert.deepEqual(core.parseInput(" \n "), { items: [], invalid: [], duplicates: 0 });
});

test("pagination stays on the exact GitHub notifications endpoint", () => {
  assert.equal(core.notificationPageUrl("?after=abc", "https://github.com/notifications?query=is%3Aunread"), "https://github.com/notifications?after=abc");
  assert.equal(core.notificationPageUrl("https://github.com/notifications#subscriptions"), "https://github.com/notifications");
  for (const url of ["/logout", "/notifications/thread/1", "https://other.test/notifications", "http://github.com/notifications", "https://x@github.com/notifications"]) {
    assert.equal(core.notificationPageUrl(url), null);
  }
});

test("recognizes the local filter without treating ordinary GitHub queries as subscriptions", () => {
  assert.equal(core.isSubscriptionQuery(" Subscriptions:only "), true);
  assert.equal(core.isSubscriptionQuery("subscriptions:only reason:mention"), false);
  assert.equal(core.isSubscriptionView("https://github.com/notifications#subscriptions"), true);
  assert.equal(core.isSubscriptionView("https://github.com/notifications?query=subscriptions%3Aonly"), true);
  assert.equal(core.isSubscriptionView("https://github.com/notifications?query=reason%3Asubscribed"), false);
  assert.equal(core.isSubscriptionView("https://github.com/acme/console/issues/1#subscriptions"), false);
  assert.equal(core.isSubscriptionView("https://other.test/notifications#subscriptions"), false);
  assert.equal(core.isPriorityQuery(" priority:only "), true);
  assert.equal(core.isPriorityView("https://github.com/notifications#priority"), true);
  assert.equal(core.isPriorityView("https://github.com/notifications?query=priority%3Aonly"), true);
  assert.equal(core.isPriorityView("https://github.com/notifications#subscriptions"), false);
});

test("scores Priority notifications from ask signal, organizational hierarchy, recency, and Kev triage", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const rules = core.validatePriorityRules({
    contacts: {
      "lead-mgr": { points: 30, tier: 1, role: "Engineering Director" },
      "vp-ops": { points: 24, tier: 2, role: "VP, Operations" },
      "staff-eng": { points: 18, tier: 3, role: "Staff Engineer" }
    },
    coreRepos: ["acme/console"]
  });
  const managerMention = core.scorePriority({
    reason: "mention",
    unread: true,
    participants: [{ username: "lead-mgr" }],
    dateTime: "2026-10-15T23:00:00Z"
  }, { now, rules });
  assert.equal(managerMention.orgScore, 30);
  assert.equal(managerMention.orgMatch.username, "lead-mgr");
  assert.ok(managerMention.score >= 85);
  assert.equal(managerMention.tier, "P1");
  assert.equal(managerMention.qualifies, true);

  const staleBackground = core.scorePriority({
    reason: "subscribed",
    unread: false,
    participants: [{ username: "stranger" }],
    dateTime: "2026-09-01T00:00:00Z"
  }, { now, rules });
  assert.equal(staleBackground.orgScore, 0);
  assert.equal(staleBackground.recencyScore, 0);
  assert.equal(staleBackground.qualifies, false);

  const kevPromoted = core.scorePriority({
    repository: "acme/console",
    reason: "subscribed",
    unread: true,
    participants: [{ username: "vp-ops" }],
    dateTime: "2026-10-15T12:00:00Z"
  }, {
    now,
    rules,
    kev: { directAsk: 0.92, blocker: 0.85, resolved: 0.05, response: "needs_response", urgency: 2.6 }
  });
  assert.ok(kevPromoted.orgScore >= 28);
  assert.ok(kevPromoted.askScore >= 40);
  assert.equal(kevPromoted.qualifies, true);

  // Fresh subscribed noise without an ask or org signal does not sneak in on recency alone
  const freshNoise = core.scorePriority({
    reason: "subscribed",
    unread: true,
    participants: [{ username: "stranger" }],
    dateTime: "2026-10-15T23:55:00Z"
  }, { now, rules });
  assert.equal(freshNoise.qualifies, false);

  // Closed/merged items are damped unless there is a live direct ask
  const closedThread = core.scorePriority({
    state: "Merged",
    reason: "comment",
    unread: false,
    participants: [{ username: "staff-eng" }],
    dateTime: "2026-10-15T20:00:00Z"
  }, { now, rules });
  assert.equal(closedThread.qualifies, false);

  // Sweep classification identifies Review requested, Team mentioned, and stale Participating while protecting Subscriptions & direct asks
  assert.deepEqual(core.classifySweep({ reason: "review-requested", unread: true }, { now, rules }), {
    sweepable: true, bucket: "review-requested", label: "Review requested"
  });
  assert.deepEqual(core.classifySweep({ reason: "team-mention", unread: true }, { now, rules }), {
    sweepable: true, bucket: "team-mention", label: "Team mentioned"
  });
  assert.deepEqual(core.classifySweep({ reason: "participating", unread: true, dateTime: "2026-09-01T00:00:00Z" }, { now, rules }), {
    sweepable: true, bucket: "stale-participating", label: "Stale participating"
  });
  assert.equal(core.classifySweep({ reason: "review-requested", unread: true }, { now, rules, subscribed: true }).sweepable, false);
  assert.equal(core.classifySweep({ reason: "participating", unread: true }, { now, rules, summaryResponse: "needs_response" }).sweepable, false);
});

test("comment previews preserve exact identity but never request notification tracking URLs", () => {
  const target = core.commentTarget("https://github.com/Acme/Console/pull/42/files?notification_referrer_id=secret#issuecomment-123");
  assert.deepEqual(target, { id: "issuecomment-123", url: "https://github.com/acme/console/pull/42", key: "acme/console#42" });
  for (const fragment of ["discussioncomment-1", "pullrequestreview-2", "discussion_r3", "r4", "commitcomment-5"]) {
    assert.equal(core.commentTarget(`/acme/console/pull/42#${fragment}`).id, fragment);
  }
  for (const value of [
    "/acme/console/issues/1", "/acme/console/issues/1#top", "/acme/console/issues/1#issuecomment-bad",
    "/acme/console/issues/1#%XX", "https://other.test/acme/console/issues/1#issuecomment-2", "/logout#issuecomment-2"
  ]) assert.equal(core.commentTarget(value), null, value);
});

test("extension manifest limits access to storage, the active tab, GitHub, and local models", () => {
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://github.com/*"]);
  assert.equal(manifest.externally_connectable, undefined);
  for (const file of [
    ...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css,
    manifest.background.service_worker, manifest.action.default_popup.split("?")[0], manifest.options_ui.page
  ]) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});
