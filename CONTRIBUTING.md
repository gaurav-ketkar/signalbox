# Contributing

Contributions, bug reports, and UI improvements are welcome!

## Design & Privacy Principles

1. **100% Local & Private:**
   - Never send GitHub notification content, cookies, or tokens to external cloud APIs.
   - AI summaries and triage talk only to loopback endpoints (`127.0.0.1:1234` for LM Studio, `127.0.0.1:11434` for Ollama, `127.0.0.1:8080` for local MLX, and `127.0.0.1:8009` for local Kev).
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

## License

By contributing to this repository, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
