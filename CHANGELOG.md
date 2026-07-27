# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-07-27

First release. One extension covering search and reading, working out of the
box with no credentials, and behaving identically on macOS and Linux.

### Search

- `glean_search` runs several queries in parallel across five backends behind a
  single tool: `codex` and `xai` (subscription), `tavily` and `perplexity`
  (optional API key), and `exa` (no credential at all).
- `backend: "auto"` walks the configured order, skips unconfigured backends
  silently, and falls through only on errors a different backend could
  plausibly survive. Auth, request and config errors surface immediately
  instead of being masked.
- `glean_x_search` searches X (Twitter) posts through xAI's live index. It
  registers only once xAI authentication is confirmed, so nobody is given a
  tool that can only fail.
- xAI works from either a Grok subscription (`/login grok-build`, registered by
  this extension) or an `XAI_API_KEY`. Each credential is routed to the host it
  is entitled to reach — a subscription cannot use `api.x.ai` and an API key is
  not recognised by the Grok CLI proxy.
- Codex citations carry character offsets into the answer text, so a claim can
  be traced to the exact sentence attributed to a source.

### Reading

- `glean_fetch` converts a URL to markdown: linkedom parses, Readability finds
  the article, turndown converts. Next.js flight data is extracted when the
  markup itself holds no article.
- Jina Reader is the single fallback for client-rendered pages. No headless
  browser is used anywhere.
- GitHub repository URLs are cloned and returned as a file tree plus README.
- PDFs are extracted inline, with an optional file for `read` and `grep`.
- YouTube videos are transcribed from subtitles, with the rolling repetition of
  auto-generated captions collapsed into readable prose.
- Local videos and YouTube videos yield frames through ffmpeg, and whole-video
  understanding through Gemini when `GEMINI_API_KEY` is set.
- `glean_get_content` pages through anything too long to inline, for both
  search results and fetched pages.
- `includeContent` prefetches page content for top citations in the background
  and wakes the agent when it lands, so search results are never blocked on it.

### Safety

- Outbound URLs are validated against a private-address blocklist before the
  socket opens, and revalidated on every redirect hop.
- URLs resolving to private addresses are never forwarded to Jina, even when
  `ssrf.allowRanges` permits them locally.
- Generated files are written under `os.tmpdir()` in a uid-scoped `0700`
  directory. Nothing is ever written under `$HOME`.
- Credentials resolve from literals, `$ENV_VAR` or `!command`, and are redacted
  from every error message.

### Configuration

- Three layers, highest wins: environment, trusted project config, user config.
  Sections merge, so a project setting cannot erase an unrelated user setting.
- `toolNames` renames any tool. Resolved names are validated at load time and a
  duplicate or a collision with a pi builtin fails loudly, because pi otherwise
  drops the loser silently.
- `/glean-status` reports backends, credentials, binaries and config paths.
  `/glean-search` browses stored results. `Ctrl+Shift+W` toggles a live
  activity panel.

[Unreleased]: https://github.com/pacoyang/pi-glean/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pacoyang/pi-glean/releases/tag/v0.1.0
