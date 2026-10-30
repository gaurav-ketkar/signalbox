#!/usr/bin/env node
// Release helper. See "Releasing" in CONTRIBUTING.md.
//   sync              npm "version" hook: copy package.json's version into the
//                     manifest and README, and date the Unreleased changelog notes.
//   verify <tag>      fail unless the tag matches manifest.json and package.json.
//   notes <version>   print that version's changelog section.
//   package [root]    build dist/signalbox-v<version>.zip from root (default: repo).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "gaurav-ketkar/signalbox";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file, root = ROOT) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, text) => fs.writeFileSync(path.join(ROOT, file), text);
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const bare = (version) => String(version || "").replace(/^v/, "");

function replaceOnce(text, pattern, replacement, what) {
  if (!pattern.test(text)) fail(`could not find ${what}`);
  return text.replace(pattern, replacement);
}

function sync() {
  const version = JSON.parse(read("package.json")).version;
  const previous = JSON.parse(read("manifest.json")).version;
  if (version === previous) fail(`manifest.json is already ${version}`);

  write("manifest.json", replaceOnce(read("manifest.json"), /("version":\s*")[^"]+(")/, `$1${version}$2`, "the manifest version"));

  let readme = read("README.md");
  readme = replaceOnce(readme, /Version \d+\.\d+\.\d+\]\(https:\/\/img\.shields\.io\/badge\/version-\d+\.\d+\.\d+/,
    `Version ${version}](https://img.shields.io/badge/version-${version}`, "the README version badge");
  readme = readme.replace(/\(`v\d+\.\d+\.\d+` \$\\rightarrow\$/, `(\`v${version}\` $\\rightarrow$`);
  write("README.md", readme);

  let changelog = read("CHANGELOG.md");
  const match = /## \[Unreleased\]\n([\s\S]*?)\n---\n/.exec(changelog);
  if (!match) fail("CHANGELOG.md has no [Unreleased] section followed by ---");
  const notes = match[1].trim();
  if (!notes) fail("add this release's notes under ## [Unreleased] in CHANGELOG.md first");
  const date = new Date().toLocaleDateString("en-CA");
  changelog = changelog.replace(match[0], `## [Unreleased]\n\n---\n\n## [${version}] - ${date}\n\n${notes}\n\n---\n`);
  changelog = replaceOnce(changelog, /^\[Unreleased\]: (\S+)\/compare\/v([\d.]+)\.\.\.HEAD$/m,
    (_, base) => `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${previous}...v${version}`,
    "the [Unreleased] compare link at the end of CHANGELOG.md");
  write("CHANGELOG.md", changelog);
  console.log(`release: synced ${previous} -> ${version}`);
}

function notesFor(version) {
  const escaped = version.replace(/\./g, "\\.");
  const match = new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?:\\n---\\n|\\n## \\[|$)`).exec(read("CHANGELOG.md"));
  return match?.[1].trim() || "";
}

function verify(tag) {
  const version = bare(tag);
  const manifest = JSON.parse(read("manifest.json")).version;
  const pkg = JSON.parse(read("package.json")).version;
  if (manifest !== version || pkg !== version) fail(`tag ${tag} does not match manifest.json ${manifest} / package.json ${pkg}`);
  if (!notesFor(version)) fail(`CHANGELOG.md has no notes for ${version}`);
  console.log(`release: ${tag} matches manifest, package, and changelog`);
}

function notes(version) {
  const body = notesFor(bare(version));
  if (!body) fail(`CHANGELOG.md has no notes for ${version}`);
  process.stdout.write(`${body}\n\n**Install:** download \`signalbox-v${bare(version)}.zip\` below, unzip it, then choose **Load unpacked** in \`chrome://extensions\`.\n\nFull history: [CHANGELOG.md](https://github.com/${REPO}/blob/v${bare(version)}/CHANGELOG.md)\n`);
}

// Everything Chrome needs lives at the top level; tests, docs, and tooling stay out.
function packageZip(root = ROOT) {
  root = path.resolve(root);
  const manifest = JSON.parse(read("manifest.json", root));
  const files = fs.readdirSync(root).filter((name) =>
    /\.(js|css|html)$/.test(name) || ["manifest.json", "LICENSE", "README.md"].includes(name)).sort();
  const required = new Set([
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...Object.values(manifest.icons || {})
  ].filter(Boolean).map((file) => file.split("?")[0]));
  for (const page of files.filter((name) => name.endsWith(".html"))) {
    for (const [, ref] of read(page, root).matchAll(/(?:src|href)="([^":#?]+\.(?:js|css))"/g)) required.add(ref);
  }
  const missing = [...required].filter((file) => !files.includes(file));
  if (missing.length) fail(`the zip would be missing ${missing.join(", ")}`);

  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `signalbox-v${manifest.version}.zip`);
  fs.rmSync(zipPath, { force: true });
  // Unzipping creates a "signalbox" folder, ready for Load unpacked.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "signalbox-"));
  fs.mkdirSync(path.join(stage, "signalbox"));
  for (const file of files) fs.copyFileSync(path.join(root, file), path.join(stage, "signalbox", file));
  execFileSync("zip", ["-qrX", zipPath, "signalbox"], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`release: built ${path.relative(ROOT, zipPath)} (${files.length} files)`);
}

const [command, argument] = process.argv.slice(2);
if (command === "sync") sync();
else if (command === "verify") verify(argument || fail("usage: verify <tag>"));
else if (command === "notes") notes(argument || fail("usage: notes <version>"));
else if (command === "package") packageZip(argument);
else fail("usage: release.mjs sync | verify <tag> | notes <version> | package [root]");
