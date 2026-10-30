# Contributing

Contributions, bug reports, and UI improvements are welcome!

## Design & Privacy Principles

1. **100% Local & Private:**
   - Never send GitHub notification content, cookies, or tokens to external cloud APIs.
   - AI summaries and triage talk only to loopback endpoints (`127.0.0.1:8000` for Splash, `127.0.0.1:1234` for LM Studio, `127.0.0.1:11434` for Ollama, `127.0.0.1:8080` for local MLX, and `127.0.0.1:8009` for local Kev).
   - Never commit personal/company usernames, org charts, or internal repository names. Use `priority-config.local.json` (gitignored) or the extension's **Priority filter rules** settings in `manager.html` for personal priority rules.
2. **Zero Runtime Dependencies:**
   - The extension runs directly from source as an unpacked Manifest V3 extension with no bundler or runtime npm dependencies.
3. **Safe DOM Rendering:**
   - Render all scraped notification titles, previews, and AI summaries as plain text (`textContent`), never `innerHTML`.

## Running Tests

Before opening a pull request, run both the unit test suite and the Playwright MV3 browser suite:

```bash
npm test
npm run test:browser
```

## Releasing

Maintainers only. Versions follow [Semantic Versioning](https://semver.org/).

1. Add the release notes under `## [Unreleased]` in `CHANGELOG.md` and commit them.
2. On a clean `main`, run `npm version patch`, `minor`, or `major`.

That one command:

- runs both test suites;
- bumps `package.json`, `package-lock.json`, `manifest.json`, and the README version;
- moves the Unreleased notes under a dated heading and updates the compare links;
- commits `Release vX.Y.Z`, creates the `vX.Y.Z` tag, and pushes both.

The tag starts the [Release workflow](.github/workflows/release.yml). It checks the tag matches the manifest, runs the unit tests, builds `signalbox-vX.Y.Z.zip`, and publishes a GitHub Release with the changelog notes and the zip attached.

Don't edit version numbers or create tags or Releases by hand. To check the zip locally, run `npm run package` and look in `dist/`.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
