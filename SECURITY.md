# Security

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/pacoyang/pi-glean/security/advisories/new). Please do not open a public issue for anything exploitable.

## The threat model

pi-glean gives a coding agent the ability to reach the network and the local filesystem. The agent's instructions come partly from pages it has read, so **any URL it fetches can influence what it fetches next**. Everything below follows from that.

Two facts are worth stating plainly:

- **Extension tools are not covered by pi's permission system.** `glean_fetch` does not prompt before it reads a file or opens a socket. Do not assume pi's approval flow stands between a prompt-injected instruction and this extension.
- **Search queries leave your machine.** They go to whichever backend is selected — OpenAI, xAI, Tavily, Perplexity or Exa. Fetched URLs may additionally go to Jina.

## Network requests (SSRF)

Every outbound URL is checked before the socket opens:

- Hostnames are resolved first, and the resolved address is checked against a blocklist covering loopback, link-local, IPv4/IPv6 private ranges, carrier-grade NAT, and the cloud metadata endpoints. A hostname that resolves to `169.254.169.254` is refused regardless of what it is called.
- Redirects are revalidated **at every hop**, so a public URL cannot bounce to an internal one.
- Only `http` and `https` are accepted, and the redirect chain is capped.
- `fetch.domainPolicy.allow` / `.deny` narrow this further; an allowlist makes everything else unreachable.
- `ssrf.allowRanges` can permit specific private ranges when you genuinely want the agent reading internal documentation. Setting it re-opens exactly what the blocklist exists to close, so set it narrowly.

### The Jina exception

Jina Reader fetches the page from **its own servers**, not from yours. A URL sent to it is a URL disclosed to a third party. pi-glean therefore refuses to forward any host that resolves to a private address to `r.jina.ai` — including hosts you have explicitly permitted through `ssrf.allowRanges`. A local allowance is not consent to publish the URL.

Set `fetch.jina.enabled: false` to remove this path entirely; local extraction continues to work.

## Local filesystem access

`glean_fetch` accepts local paths (`/…`, `./…`, `../…`, `~/…`, `file://…`) so it can read video files. It only proceeds for paths with a recognised video extension, but that is a usability filter, not a security boundary — a file named `secret.mp4` will be read. Set `video.enabled: false` to remove local path handling.

When Gemini analysis is requested, the file is **uploaded to Google**, then deleted after the query. Whole-video understanding only runs when `GEMINI_API_KEY` is set and a `prompt` is given.

## Files written

pi-glean never writes into `$HOME`. Generated files go under `os.tmpdir()` in a directory keyed to your uid and created with mode `0700`:

- `pi-glean-repos-<uid>` — GitHub clones
- `pi-glean-pdf-<uid>` — extracted PDFs, only when `pdf.writeFile` is enabled
- `pi-glean-youtube-<uid>` — subtitle downloads, removed after each use

`github.clonePath` and `pdf.outputDir` can override these. Paths inside a cloned repository are resolved through `realpath` and rejected if they escape the clone root, so neither `../` nor a symlink can reach outside it.

## Credentials

- Subscription credentials for Codex and xAI are held by pi. This extension asks pi's model registry for them and never reads `auth.json`.
- Optional API keys may be given literally, as `"$ENV_VAR"`, or as `"!command"`. A command runs at request time with a minimized environment, a 5 second timeout, and a 16 KiB output cap; output containing control characters is rejected rather than sent in a header.
- Credential values are stripped from error messages before those messages are shown or logged.

## Subprocesses

`git`, `gh`, `ffmpeg`, `ffprobe` and `yt-dlp` are invoked through `execFile` with argument arrays — never through a shell — so URLs and filenames cannot become shell syntax. Each invocation has a timeout that escalates from `SIGTERM` to `SIGKILL`, so a wedged process cannot outlive the tool call.

`youtube.ytDlpArgs` is passed to `yt-dlp` verbatim. It exists as an escape hatch for authenticated access, and it is your responsibility: anything you can express as a yt-dlp flag, including reading browser cookies, will be executed.

## What pi-glean deliberately does not do

- No headless browser, and no browser automation of any kind.
- No reading of browser cookie stores or profiles.
- No writing anywhere under `$HOME`.
- No telemetry.

## Third parties that see your data

| Service             | Sees                    | When                                                   |
| ------------------- | ----------------------- | ------------------------------------------------------ |
| OpenAI              | Search queries          | `codex` backend                                        |
| xAI                 | Search queries          | `xai` backend, `glean_x_search`                        |
| Tavily / Perplexity | Search queries          | Those backends, when a key is configured               |
| Exa                 | Search queries          | `exa` backend — the default when nothing is configured |
| Jina                | Fetched URLs            | Only when local extraction fails                       |
| Google              | Video files and prompts | Only when `GEMINI_API_KEY` is set                      |
| GitHub              | Repository names        | GitHub URLs                                            |
| YouTube             | Video ids               | YouTube URLs                                           |
