# Contributing

Contributions, bug reports, and UI improvements are welcome!

## Design & Privacy Principles

1. **Local by Default, Explicit Cloud Use:**
   - Local inference is the default. Optional cloud inference sends selected thread context to the configured provider; never claim cloud mode keeps that content on-device.
   - Never forward GitHub session cookies to inference providers. Provider credentials authenticate only the intended provider. See [storage and privacy boundaries](docs/HOW_IT_WORKS.md#6-storage--privacy).
   - Local summaries and triage use loopback endpoints (`127.0.0.1:8000` for Splash, `127.0.0.1:1234` for LM Studio, `127.0.0.1:11434` for Ollama, `127.0.0.1:8080` for local MLX, and `127.0.0.1:8009` for local Kev).
   - Never commit personal/company usernames, org charts, or internal repository names. Use `priority-config.local.json` (gitignored) or the extension's **Priority filter rules** settings in `manager.html` for personal priority rules.
2. **Zero Runtime Dependencies:**
   - The extension runs directly from source as an unpacked Manifest V3 extension with no bundler or runtime npm dependencies.
3. **Safe DOM Rendering:**
   - Render all scraped notification titles, previews, and AI summaries as plain text (`textContent`), never `innerHTML`.

## Running Tests

Read the [repository security baseline](.github/instructions/app-security.instructions.md)
before extension work. Use Node 24.22.2 and npm 11.21.2 (pinned in
`package.json`). In a disposable, non-root VM/container with no host credentials
or everyday browser profile, restricted mounts, scrubbed environment, and enforced
outbound restrictions, install only when needed:

```bash
npm ci --ignore-scripts
```

`.npmrc` blocks install lifecycle scripts, rejects incompatible engines on
installs, and applies a seven-day age filter to new dependency resolution.
`npm ci` freezes the reviewed lock; it is not a fresh publication-age check.
Review lockfile diffs and publication dates before accepting them. No dependency
update bot is configured; if one is introduced, give routine npm updates a
seven-day cooldown too. For an urgent verified security fix, obtain approval for
an exact package/version exception, pin the fix, and remove temporary exemptions.
Do not disable the cooldown globally or treat it as a substitute for review.

Before opening a pull request, run both the unit test suite and the Playwright MV3 browser suite:

```bash
npm test
npm run test:browser
```

Explicit `npm test` and `npm run` commands still execute project code despite
`ignore-scripts`; run them only in isolation. Browser tests use synthetic fixtures
and a separate profile. Never attach a signed-in personal browser or expose a
debugging port. Browser installation/build scripts require separate review and
restricted execution; the repository does not provision OS isolation itself.
Before release, also check secrets in source/history/shipped assets, scan the
complete development lockfile, and verify denied boundary actions and actual
network exposure. A skipped gate must be reported, not counted as passed.

## Demo and Hero Assets

The README demo and hero image are generated from scripts, using synthetic data only.

```bash
node scripts/hero.mjs                                   # docs/hero-light.svg and docs/hero-dark.svg
uv run --with kokoro --with soundfile python scripts/demo-voice.py /tmp/sbx-demo   # voice-over from scripts/demo-narration.json
node scripts/record-demo.cjs /tmp/sbx-demo              # docs/demo.mp4 and docs/demo.gif
```

The recorder loads the real extension in Playwright with a fake local model, so it needs no network or API keys. It also needs `ffmpeg`.

## Releasing

Maintainers only. Versions follow [Semantic Versioning](https://semver.org/).

1. Add the release notes under `## [Unreleased]` in `CHANGELOG.md` and commit them.
2. On a clean `main`, after reviewing the release hooks in `package.json`, run
   `npm --ignore-scripts=false version patch`, `minor`, or `major`. This explicit,
   maintainer-only exception enables those hooks, including their push; do not
   use it for dependency installs.

That one command:

- runs both test suites;
- bumps `package.json`, `package-lock.json`, `manifest.json`, and the README version;
- moves the Unreleased notes under a dated heading and updates the compare links;
- commits `Release vX.Y.Z`, creates the `vX.Y.Z` tag, and pushes both.

The tag starts the [Release workflow](.github/workflows/release.yml). It checks the tag matches the manifest, runs the unit tests, builds `signalbox-vX.Y.Z.zip`, and publishes a GitHub Release with the changelog notes and the zip attached.

Don't edit version numbers or create tags or Releases by hand. To check the zip locally, run `npm run package` and look in `dist/`.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
