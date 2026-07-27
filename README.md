# pi-glean

Zero-config web search and URL fetching for [pi](https://github.com/earendil-works/pi) — works with no API keys, and uses your ChatGPT Plus/Pro or Grok subscription for higher-quality answers when available. Plus GitHub repos, PDFs, YouTube, and video frames.

```bash
pi install npm:pi-glean
```

Or load a local checkout without installing, with `pi -e /path/to/pi-glean`.

That is the whole setup. Search works immediately through Exa's public MCP endpoint, which needs no credential; URL fetching needs no credential either. Subscriptions and API keys are optional upgrades, and `/glean-status` will always tell you which ones are in play.

## Tools

| Tool                | What it does                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `glean_search`      | Runs one or more queries in parallel across the configured backends                |
| `glean_x_search`    | Searches X (Twitter) posts directly through xAI's live index                       |
| `glean_fetch`       | Reads a URL as markdown — articles, docs, PDFs, GitHub repos, YouTube, local video |
| `glean_get_content` | Pages through anything too long to inline                                          |

`glean_x_search` only appears once xAI authentication is confirmed. The other three register at load time, because they work with nothing configured.

### Why X search is separate

`glean_search(backend: "xai")` and `glean_x_search` are different xAI endpoints, not two routes to the same thing: the first is general web search, the second queries X's corpus. General web search indexes X poorly and its results are stale, so a question about what people are saying on X needs the second tool.

## Search backends

`backend: "auto"` walks `search.providers` in order, skipping any that are not configured, and falls through to the next only on errors where a different backend could actually succeed (`quota`, `transient`, `network` by default). An auth failure or a bad request is reported immediately rather than masked by a fallback.

| Order | Backend      | Credential                               | Returns                                               |
| ----- | ------------ | ---------------------------------------- | ----------------------------------------------------- |
| 1     | `codex`      | ChatGPT Plus/Pro — `/login openai-codex` | Synthesized answer, citations carry character offsets |
| 2     | `xai`        | Grok subscription — `/login grok-build`  | Synthesized answer, citations carry offsets           |
| 3     | `tavily`     | `TAVILY_API_KEY` (has a free tier)       | Synthesized answer                                    |
| 4     | `perplexity` | `PERPLEXITY_API_KEY`                     | Synthesized answer                                    |
| 5     | `exa`        | **none**                                 | Real page text, not a summary                         |

Subscriptions come first because that quota is already paid for. Keyed backends sit ahead of `exa` because `exa` always succeeds — anything after it would never run. `exa` is last precisely so a fresh install with nothing configured still works.

## Reading

`glean_fetch` parses the page locally first (linkedom → Readability → turndown). When that yields nothing usable — typically a client-rendered page whose markup holds no text — it falls back to [Jina Reader](https://jina.ai/reader/). There is no headless browser anywhere in this package.

It also handles:

- **GitHub repositories** — cloned via `gh` or `git`, returning the file tree and README so the agent can read and grep real files
- **PDFs** — extracted inline; set `pdf.writeFile` to also drop a file you can `read` and `grep`
- **YouTube** — subtitles via `yt-dlp`, with the rolling repetition of auto-generated captions collapsed into a readable transcript
- **Video** — frames from any local file or YouTube video via `ffmpeg`, and whole-video understanding through Gemini when `GEMINI_API_KEY` is set

Frames need no credential. Whole-video understanding is the only part that does, and when it is unavailable you get the frames plus a note explaining what else was possible — never an error in place of work that succeeded.

### Signing in to xAI

Two ways in, and the difference matters more than it looks:

|                    | Grok subscription                           | xAI API key                    |
| ------------------ | ------------------------------------------- | ------------------------------ |
| Set up with        | `/login grok-build`                         | `XAI_API_KEY`, or `/login xai` |
| Endpoint           | `cli-chat-proxy.grok.com`                   | `api.x.ai`                     |
| Extra OAuth scopes | `conversations:read`, `conversations:write` | —                              |

The scopes are what unlock the Responses search tools. A plain `xai` credential
without API credit gets `429 resource-exhausted` at a team rate limit of 0
requests per minute on every model, because those calls bill against API spend
rather than the subscription.

`/login grok-build` is the verified path. The API-credit column follows from
xAI's own error — the tier is set by historical API spend — but has not been
tested against a funded account, so treat it as the documented behaviour rather
than a confirmed one.

Nothing else needs configuring. pi-glean registers the subscription grant itself,
so `/login grok-build` needs no other extension installed; `XAI_API_KEY` is read
from pi's own xAI slot and needs no login at all. The subscription wins when both
are present, and each credential goes to the host it is entitled to reach. The two hosts are not interchangeable: an API key is not
recognised by the proxy. Set `search.xai.baseUrl` to override.


### Known limitations

- **Branch names containing a slash.** In `github.com/o/r/blob/feat/x/src/a.ts` there is no way to tell from the URL alone where the branch ends and the path begins. The clone succeeds but the file may not be found; fetch the repository root and navigate from there. The error message says so when it happens.
- **Videos longer than about an hour** exceed what Gemini accepts. pi-glean checks the duration first and says so rather than letting the tail be silently dropped — ask about a specific range with `timestamp` instead.
- **YouTube subtitle availability** is tightening for unauthenticated clients. If `yt-dlp` starts returning nothing, `youtube.ytDlpArgs` lets you supply your own flags; pi-glean will never reach into your browser profile on its own.

## Optional binaries

Missing binaries degrade one capability, never the whole fetch:

| Binary               | Needed for          | Without it                                      |
| -------------------- | ------------------- | ----------------------------------------------- |
| `git` / `gh`         | GitHub repositories | GitHub URLs fall back to ordinary HTML fetching |
| `ffmpeg` / `ffprobe` | Frame extraction    | Only frame requests fail                        |
| `yt-dlp`             | YouTube transcripts | Gemini is used instead when configured          |

`/glean-status` lists which are present and prints the right install command for your platform.

## Commands and shortcuts

- `/glean-status` — backends, credentials, binaries, config file locations
- `/glean-search` — browse, inspect and delete what this session has stored
- `Ctrl+Shift+W` — toggle a live activity panel showing requests, timings and rate-limit headroom

## Configuration

Three layers, highest wins: environment variables, then `<cwd>/.pi/pi-glean.json` (only in a trusted project), then `~/.pi/pi-glean.json`. Sections merge, so setting `fetch.timeoutMs` in a project does not erase `fetch.jina` from your home config.

```jsonc
{
  "search": {
    "backend": "auto",
    "providers": ["codex", "xai", "tavily", "perplexity", "exa"],
    "batchSize": 5,
    "fallbackOn": ["quota", "transient", "network"],
  },
  "fetch": {
    "timeoutMs": 30000,
    "maxInlineChars": 30000,
    "jina": { "enabled": true, "apiKey": null },
    "domainPolicy": { "allow": [], "deny": [] },
  },
  "github": { "enabled": true, "maxRepoSizeMB": 350 },
  "pdf": { "maxPages": 100, "writeFile": false, "outputDir": null },
  "youtube": { "enabled": true, "subtitleLangs": ["en"], "preferAutoSubs": true, "ytDlpArgs": [] },
  "video": { "enabled": true, "maxSizeMB": 50, "preferredModel": "gemini-3-flash-preview" },
  "toolNames": { "search": "glean_search", "fetch": "glean_fetch" },
}
```

Any API key field also accepts `"$SOME_ENV_VAR"` or `"!command to run"` (resolved at request time, 5s timeout, output redacted from errors).

Environment variables are kept deliberately few — anything the config file can express has no environment equivalent, so there is never a question of which one won:

| Variable                                | Purpose                                           |
| --------------------------------------- | ------------------------------------------------- |
| `PI_GLEAN_ENABLED`                      | Master switch                                     |
| `PI_GLEAN_CONFIG`                       | Override the user-level config path               |
| `TAVILY_API_KEY` / `PERPLEXITY_API_KEY` | Optional synthesized-answer backends              |
| `JINA_API_KEY`                          | Raises Jina Reader from 20 to 500 requests/minute |
| `GEMINI_API_KEY`                        | Whole-video understanding                         |
| `GOOGLE_GEMINI_BASE_URL`                | Gemini endpoint override                          |

### Renaming the tools

pi keeps the **first** registration of any tool name and silently drops later ones, with the winner decided by extension load order. If another extension already claims a name, set `toolNames` — pi-glean validates the resolved names at load time and refuses to start on a duplicate or a collision with a pi builtin, rather than letting a tool vanish quietly.

## Security

`glean_fetch` reaches the network on the agent's behalf, which means a prompt-injected URL is reaching it too. Every request is validated against a private-address blocklist before the socket opens, and again on each redirect hop. The Jina fallback additionally refuses any host that resolves privately, even one you have explicitly allowed locally — Jina fetches from its own servers, so forwarding an internal URL would disclose it to a third party.

`glean_fetch` also accepts local paths for video files, and extension tools are not covered by pi's permission system. See [SECURITY.md](SECURITY.md) for the full picture.

## A note on the Codex backend

The `codex` backend talks to `chatgpt.com/backend-api/codex/*` the way the official Codex CLI does. That interface is not documented or supported for third-party use; it can change or stop working without notice, and using it is subject to OpenAI's terms. It is optional — every other backend is unaffected if it breaks.


## License

MIT © 2026 pacoyang
