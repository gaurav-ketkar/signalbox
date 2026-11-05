// Records the README demo with the real extension, synthetic data, and a fake local model.
// Usage: node scripts/record-demo.cjs [voice-dir]
// voice-dir holds vo-0.wav … vo-5.wav and durations.json from scripts/demo-voice.py.
// Writes docs/demo.mp4 and docs/demo.gif. Needs Playwright's Chromium and ffmpeg.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const core = require("../core.js");
const summaries = require("../summary.js");
const fixture = require("../test/fixtures.cjs");

const root = path.resolve(__dirname, "..");
const voiceDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "sbx-demo"));
const durations = JSON.parse(fs.readFileSync(path.join(voiceDir, "durations.json"), "utf8"));
const size = { width: 1280, height: 800 };
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
const MODEL = "gemma4:12b-it-qat";
const DETAILS_PREFIX = "subscription-details:v1:";

const rules = {
  contacts: {
    "maya-vp": { points: 40, tier: 1, role: "VP, Engineering" },
    "sam-dir": { points: 30, tier: 2, role: "Director, Platform" },
    "jordan-sec": { points: 25, tier: 2, role: "Security Lead" },
    "alex-staff": { points: 20, tier: 3, role: "Staff Engineer" },
    "taylor-eng": { points: 12, tier: 3, role: "Engineer" }
  },
  coreRepos: ["acme/platform", "acme/auth-service"],
  adjacentRepos: ["acme/billing-engine"]
};

// Each item: notification row, the comment GitHub would show, and what the "model" says about it.
const items = [
  {
    href: "/acme/platform/pull/412#issuecomment-41201", title: "Confirm Q4 latency SLA targets before architecture review",
    reason: "mention", participants: ["maya-vp", "alex-staff"], icon: "octicon-git-pull-request", minutes: 25,
    author: "maya-vp", comment: "<p>@you can you confirm the p99 latency targets (250 ms read, 400 ms write) before Friday's architecture review? I need your sign-off to lock the Q4 SLA.</p>",
    key: "p99 latency targets",
    result: { summary: "@maya-vp needs your sign-off on the Q4 p99 latency targets before Friday's architecture review.", action: "Confirm 250 ms read / 400 ms write, or propose new numbers.", response: "needs_response", evidence: "@you can you confirm the p99 latency targets", blocker: false, resolved: false, deadline: "Friday" }
  },
  {
    href: "/acme/auth-service/issues/305#issuecomment-30501", title: "Rotate staging OAuth signing keys after regional failover",
    reason: "mention", participants: ["jordan-sec"], icon: "octicon-issue-opened", minutes: 60,
    author: "jordan-sec", comment: "<p>The staging failover is done. @you can you rotate the OAuth signing keys in us-west-2 before tomorrow's pen test?</p>",
    key: "rotate the OAuth signing keys",
    result: { summary: "@jordan-sec needs you to rotate the staging OAuth signing keys before tomorrow's pen test.", action: "Rotate the us-west-2 keys and reply when done.", response: "needs_response", evidence: "@you can you rotate the OAuth signing keys in us-west-2 before tomorrow's pen test?", blocker: false, resolved: false, deadline: "tomorrow" }
  },
  {
    href: "/acme/billing-engine/pull/889#issuecomment-88901", title: "Idempotency key validation for webhook retries",
    reason: "author", participants: ["sam-dir", "alex-staff"], icon: "octicon-git-merge", minutes: 120,
    author: "sam-dir", comment: "<p>Shipped in v3.8. Retries are idempotent now and the duplicate-charge alerts stopped overnight. Nothing needed from you, thanks!</p>",
    key: "idempotent now",
    result: { summary: "@sam-dir says your idempotency fix shipped in v3.8 and duplicate charges stopped.", action: "No action needed.", response: "fyi", evidence: "", blocker: false, resolved: true, deadline: "" }
  },
  {
    href: "/acme/platform/pull/431#issuecomment-43101", title: "Bump Envoy rate-limit config for public GraphQL tier",
    reason: "review-requested", participants: ["taylor-eng"], icon: "octicon-git-pull-request", minutes: 180,
    author: "taylor-eng", comment: "<p>This is blocking Thursday's deploy: the public GraphQL tier hits 429s at 60% of expected load. @you can you review before Thursday?</p>",
    key: "blocking Thursday's deploy",
    result: { summary: "@taylor-eng needs your review: this rate-limit bump is blocking Thursday's deploy.", action: "Review the PR before Thursday.", response: "needs_response", evidence: "@you can you review before Thursday?", blocker: true, resolved: false, deadline: "Thursday" }
  },
  {
    href: "/acme/platform/issues/398#issuecomment-39801", title: "Weekly release train checklist — v2.14",
    reason: "team-mention", participants: ["release-bot"], icon: "octicon-issue-opened", minutes: 240,
    author: "release-bot", comment: "<p>The v2.14 checklist is posted. Code freeze is Wednesday at 5 pm PT.</p>",
    key: "Code freeze is Wednesday",
    result: { summary: "The v2.14 release checklist is up; code freeze is Wednesday at 5 pm PT.", action: "No action needed.", response: "fyi", evidence: "", blocker: false, resolved: false, deadline: "" }
  },
  {
    href: "/acme/design-system/pull/77#issuecomment-7701", title: "Deprecate v1 settings modal styles",
    reason: "comment", participants: ["chris-ui"], icon: "octicon-git-pull-request", minutes: 300,
    author: "chris-ui", comment: "<p>Merged the deprecation warnings. Removal lands in v5, and the migration guide is linked above.</p>",
    key: "deprecation warnings",
    result: { summary: "Deprecation warnings merged; the old styles go away in v5.", action: "No action needed.", response: "fyi", evidence: "", blocker: false, resolved: false, deadline: "" }
  },
  {
    href: "/acme/platform/discussions/12#discussioncomment-1201", title: "RFC: move CI to merge queues",
    reason: "subscribed", participants: ["alex-staff"], icon: "octicon-comment-discussion", minutes: 1440,
    author: "alex-staff", comment: "<p>Where we are: most teams favor merge queues. The open question is how to quarantine flaky tests. We'll decide at Tuesday's architecture sync.</p>",
    key: "favor merge queues",
    result: { summary: "Most teams favor merge queues; flaky-test quarantine is the open question. Decision at Tuesday's sync.", action: "No action needed yet.", response: "fyi", evidence: "", blocker: false, resolved: false, deadline: "" }
  },
  {
    href: "/acme/billing-engine/pull/902#issuecomment-90201", title: "Bump lodash from 4.17.21 to 4.17.22",
    reason: "subscribed", participants: ["dependabot"], icon: "octicon-git-pull-request", minutes: 400,
    author: "dependabot", comment: "<p>Bumps lodash from 4.17.21 to 4.17.22.</p>",
    key: "Bumps lodash",
    result: { summary: "Dependabot bumps lodash to 4.17.22, a patch release.", action: "No action needed.", response: "fyi", evidence: "", blocker: false, resolved: false, deadline: "" }
  },
  {
    href: "/acme/auth-service/issues/310#issuecomment-31001", title: "Flaky test: token refresh under clock skew",
    reason: "assign", participants: ["taylor-eng"], icon: "octicon-issue-opened", minutes: 150,
    author: "taylor-eng", comment: "<p>Assigning this to you. Token refresh fails in about 3% of runs when the clock skews by more than 2 s. @you can you look at it this sprint?</p>",
    key: "clock skews by more than",
    result: { summary: "@taylor-eng assigned you a flaky token-refresh test that fails ~3% of runs under clock skew.", action: "Look into it this sprint.", response: "needs_response", evidence: "@you can you look at it this sprint?", blocker: false, resolved: false, deadline: "" }
  }
];

// A bookmarked issue with no recent notification. Subscriptions shows its latest comment anyway.
const quiet = {
  url: "https://github.com/acme/platform/issues/377", title: "Multi-region failover program",
  author: "sam-dir", minutes: 190, comment: "<p>Phase 2 cutover moved to Nov 18. The EU-Central failover drill passed with a 4 minute recovery.</p>",
  key: "Phase 2 cutover",
  result: { summary: "Phase 2 cutover moved to Nov 18; the EU-Central failover drill passed.", action: "No action needed.", response: "fyi", evidence: "", blocker: false, resolved: false, deadline: "" }
};

const briefing = {
  headline: "Two leaders need you today: sign off on Q4 latency targets for @maya-vp and rotate staging keys for @jordan-sec.",
  items: [
    { label: "acme/platform#412", line: "@maya-vp (VP, Engineering) needs the Q4 p99 targets confirmed before Friday's review." },
    { label: "acme/auth-service#305", line: "@jordan-sec (Security Lead) needs staging keys rotated before tomorrow's pen test." },
    { label: "acme/auth-service#310", line: "@taylor-eng assigned you a flaky token-refresh test for this sprint." }
  ]
};

function relative(minutes) {
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : "yesterday";
}

function inboxHtml(rows) {
  let html = fixture.notifications({ rows, next: null })
    .replace("GitHub notifications extension / Synthetic test fixture, not your account", "Signalbox demo · synthetic data · local AI")
    .replace("Notifications - synthetic test fixture", "Notifications");
  let index = 0;
  html = html.replace(/<span class="fixture-meta">acme \/ console<\/span>/g, () => {
    const [, owner, repo, , number] = rows[index].href.match(/^\/([^/]+)\/([^/]+)\/(\w+)\/(\d+)/);
    const meta = `${owner} / ${repo} #${number}`;
    index++;
    return `<span class="fixture-meta">${meta}</span>`;
  });
  // GitHub shows participants as small avatars, not names.
  const palette = ["#8250df", "#1f883d", "#bf3989", "#0969da", "#bc4c00", "#57606a"];
  html = html.replace(/<a class="avatar" href="\/([^"]+)" aria-label="[^"]+">[^<]+<\/a>/g, (_, login) => {
    const color = palette[[...login].reduce((sum, character) => sum + character.charCodeAt(0), 0) % palette.length];
    return `<a class="avatar" href="/${login}" aria-label="${login}" title="${login}" style="background:${color}">${login[0].toUpperCase()}</a>`;
  }).replace("</style>", ".AvatarStack-body{display:flex}.AvatarStack-body a{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;margin-left:-4px;border:2px solid var(--bgColor-default);color:#fff;font-size:10px;font-weight:600;text-decoration:none}.AvatarStack-body a:first-child{margin-left:0}</style>");
  index = 0;
  return html.replace(/(<relative-time datetime="[^"]+">)2 hours ago(<\/relative-time>)/g, (_, open, close) => `${open}${relative(rows[index++].minutes)}${close}`);
}

function commentHtml({ id, author, minutes, comment, title }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><div class="js-discussion-timeline">
    <div class="timeline-comment" id="${id}"><a class="author" href="/${author}">${author}</a>
    <relative-time datetime="${ago(minutes)}">${relative(minutes)}</relative-time>
    <div class="comment-body js-comment-body">${comment}</div></div>
  </div></main></body></html>`;
}

function itemFor(url) {
  const parsed = core.parseItem(url);
  if (!parsed) return null;
  if (parsed.url === quiet.url) return { ...quiet, id: "issuecomment-37701" };
  const item = items.find((entry) => core.parseItem(`https://github.com${entry.href}`).key === parsed.key);
  return item && { ...item, id: item.href.split("#")[1] };
}

const cursorScript = () => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `#demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .05s linear}
#demo-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #2f81f7;background:rgba(47,129,247,.18);
z-index:2147483646;pointer-events:none;animation:demo-ripple .55s ease-out forwards}
@keyframes demo-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}`;
    document.documentElement.append(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.2 14.2 L10 20.5 L12.8 19.3 L10.1 13.2 L16 13.2 Z" fill="#fff" stroke="#1f2328" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cursor);
    const place = (x, y) => { cursor.style.transform = `translate(${x - 3}px,${y - 2}px)`; };
    const saved = JSON.parse(sessionStorage.getItem("demo-cursor") || "null");
    place(saved?.x ?? 640, saved?.y ?? 420);
    addEventListener("mousemove", (event) => {
      place(event.clientX, event.clientY);
      sessionStorage.setItem("demo-cursor", JSON.stringify({ x: event.clientX, y: event.clientY }));
    }, true);
    addEventListener("mousedown", (event) => {
      const ripple = document.createElement("div");
      ripple.className = "demo-ripple";
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      document.documentElement.append(ripple);
      setTimeout(() => ripple.remove(), 600);
    }, true);
  };
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(60);
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "sbx-record-"));
  const videoDir = path.join(work, "video");
  const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: size,
    colorScheme: "light",
    recordVideo: { dir: videoDir, size },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--disable-background-networking"]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  for (const existing of context.pages()) await existing.close();

  const rows = items.map(({ href, title, reason, participants, icon, minutes }) => ({
    href, title, reason, participants, icon, minutes, unread: true, dateTime: ago(minutes),
    reasonTitle: reason === "mention" ? "You were mentioned" : reason === "assign" ? "You were assigned" : ""
  }));
  await context.route("https://github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/hovercard")) return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    if (request.method() === "POST") return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    if (url.pathname === "/notifications") {
      const query = url.searchParams.get("query") || "";
      const reason = query.match(/reason:([\w-]+)/)?.[1];
      const shown = reason ? rows.filter((row) => row.reason === reason) : query ? [] : rows;
      return route.fulfill({ contentType: "text/html", body: inboxHtml(shown) });
    }
    const item = request.resourceType() === "fetch" && itemFor(url.href);
    if (item) return route.fulfill({ contentType: "text/html", body: commentHtml(item) });
    return route.fulfill({ contentType: "text/html", body: fixture.itemPage() });
  });

  await worker.evaluate(async ({ summaryKey, rulesKey, rules, model, records, results, briefing }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [summaryKey]: { model, automatic: false }, [rulesKey]: rules, ...records });
    const original = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith("http://127.0.0.1:11434/")) return original(input, options);
      const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
      if (!url.endsWith("/api/chat")) {
        return json({ models: [{ name: model, size: 7151000000, details: { format: "gguf" }, capabilities: ["completion"] }] });
      }
      const body = options.body ? JSON.parse(options.body) : {};
      const text = JSON.stringify(body);
      const isBriefing = Boolean(body?.format?.properties?.headline);
      await new Promise((resolve) => setTimeout(resolve, isBriefing ? 1400 : 700 + Math.random() * 1500));
      options.signal?.throwIfAborted();
      const match = results.find(({ key }) => text.includes(key));
      const content = isBriefing ? briefing : match?.result || { summary: "Routine update.", action: "No action needed.", response: "fyi", evidence: "" };
      return json({ done: true, done_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } });
    };
  }, {
    summaryKey: summaries.STORAGE_KEY,
    rulesKey: core.PRIORITY_RULES_STORAGE_KEY,
    rules,
    model: MODEL,
    briefing,
    results: [...items, quiet].map(({ key, result }) => ({ key, result })),
    records: Object.fromEntries([quiet.url, "https://github.com/acme/auth-service/issues/305"].map((url, index) => {
      const item = core.parseItem(url);
      const title = url === quiet.url ? quiet.title : items[1].title;
      return [
        [core.STORAGE_PREFIX + item.key, { url: item.url, savedAt: now - (index + 1) * 86400000 }],
        [DETAILS_PREFIX + item.key, { title, state: "open", checkedAt: now }]
      ];
    }).flat())
  });

  await context.addInitScript(cursorScript);
  const page = await context.newPage();
  const t0 = Date.now();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const marks = [];
  const lastEnd = { at: 0 };
  // Each scene starts its narration line and lasts at least as long as the line.
  async function scene(index, body) {
    const start = Date.now();
    marks.push((start - t0) / 1000);
    try {
      await body();
    } catch (error) {
      await page.screenshot({ path: path.join(os.tmpdir(), "sbx-demo-failure.png") }).catch(() => {});
      throw error;
    }
    const minimum = start + (durations[index] + 0.7) * 1000;
    if (Date.now() < minimum) await sleep(minimum - Date.now());
    lastEnd.at = (Date.now() - t0) / 1000;
  }
  async function moveTo(locator, steps = 22) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
    await sleep(220);
  }
  async function click(locator, steps) {
    await moveTo(locator, steps);
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
  }
  // The Summarize button turns into Stop while a run is going; wait so a click never cancels one.
  async function summarizeWhenIdle(locator, label) {
    await until(async () => await locator.isEnabled() && /^Summarize/.test((await locator.textContent()).trim()), label, 30000);
    await click(locator);
  }
  const doneCount = () => page.locator(".gns-ai-summary[data-state='done']").count();

  await page.goto("https://github.com/notifications");
  await page.locator("[data-gns-native-toolbar]").waitFor();
  await page.mouse.move(900, 300);
  await sleep(900);

  await scene(0, async () => {
    const titles = page.locator(".notifications-list-item .markdown-title");
    await moveTo(titles.nth(0), 30);
    await moveTo(titles.nth(2), 30);
    await moveTo(titles.nth(4), 30);
  });

  await scene(1, async () => {
    await click(page.locator("[data-gns-today-filter]"));
    await page.locator("[data-gns-panel='today']").waitFor();
    await until(async () => (await page.locator(".gns-today-headline").textContent()).includes("leaders"), "Today briefing");
    await moveTo(page.locator(".gns-today-headline"), 18);
    await sleep(1400);
  });

  await scene(2, async () => {
    await click(page.locator("[data-gns-priority-filter]"));
    await page.locator("[data-gns-panel]").waitFor();
    await until(async () => (await page.locator(".gns-result").count()) > 3, "Priority rows");
    await sleep(600);
    await summarizeWhenIdle(page.locator(".gns-summarize").first(), "Priority summarize");
    const resort = page.locator(".gns-resort");
    await until(() => resort.isVisible(), "Re-sort chip");
    await sleep(900);
    await click(resort);
    await sleep(1600);
  });

  await scene(3, async () => {
    await click(page.locator("nav[aria-label='Notifications'] a[href='/notifications']").first());
    await page.locator("[data-gns-native-toolbar]").waitFor();
    await sleep(500);
    await summarizeWhenIdle(page.getByRole("button", { name: "Summarize comments", exact: true }), "Inbox summarize");
    await until(async () => (await doneCount()) >= items.length, "Inbox summaries", 30000);
    await sleep(1000);
  });

  await scene(4, async () => {
    const rfc = page.locator(".notifications-list-item").filter({ hasText: "RFC: move CI to merge queues" });
    await click(rfc.locator("[data-gns-pin]"));
    await sleep(900);
    await click(page.locator("[data-gns-filter]"));
    await page.locator("[data-gns-panel]").waitFor();
    await until(async () => (await page.locator(".gns-quiet-pill").count()) === 1, "Quiet row");
    await sleep(500);
    if ((await doneCount()) < 3) await summarizeWhenIdle(page.locator(".gns-summarize").first(), "Subscriptions summarize");
    await until(async () => (await doneCount()) >= 3, "Subscription summaries", 20000);
    await moveTo(page.locator(".gns-result").filter({ has: page.locator(".gns-quiet-pill") }).locator(".gns-ai-text").first(), 20);
    await sleep(1300);
  });

  await scene(5, async () => {
    await click(page.locator(".gns-menu-button").first());
    await page.locator(".gns-menu-panel").waitFor();
    await moveTo(page.locator(".gns-menu-panel .gns-settings"), 14);
    await sleep(700);
    await page.goto(`chrome-extension://${extensionId}/manager.html#summaries`);
    const server = page.locator("#summary-server");
    await server.waitFor();
    await page.getByRole("heading", { name: "AI summaries & model routing" }).evaluate((heading) => {
      heading.scrollIntoView({ block: "start" });
      scrollBy(0, -32);
    });
    await moveTo(server, 16);
    await sleep(1600);
  });
  await sleep(600);

  const video = page.video();
  await context.close();
  const raw = await video.path();
  if (errors.length) console.warn("Page errors:", errors);

  const start = Math.max(0, marks[0] - 0.6);
  const length = lastEnd.at + 0.5 - start;
  const delays = marks.map((mark) => Math.round((mark - start) * 1000) + 250);
  const mp4 = path.join(root, "docs", "demo.mp4");
  const gif = path.join(root, "docs", "demo.gif");
  const inputs = durations.flatMap((_, index) => ["-i", path.join(voiceDir, `vo-${index}.wav`)]);
  const filter = delays.map((delay, index) => `[${index + 1}:a]adelay=${delay}|${delay}[a${index}]`).join(";") +
    `;${delays.map((_, index) => `[a${index}]`).join("")}amix=inputs=${delays.length}:normalize=0[aout]`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(start), "-t", length.toFixed(2), "-i", raw, ...inputs,
    "-filter_complex", filter, "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "slow", "-crf", "22",
    "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf",
    "fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    gif]);
  await fsp.rm(work, { recursive: true, force: true });
  console.log(JSON.stringify({ seconds: Number(length.toFixed(1)), scenes: marks.map((mark) => Number((mark - start).toFixed(1))), mp4, gif }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
