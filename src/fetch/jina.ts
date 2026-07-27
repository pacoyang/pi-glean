/**
 * Jina Reader fallback.
 *
 * `r.jina.ai` renders the page in a real browser server-side and returns
 * markdown. It is the only way to turn an arbitrary JS-rendered URL into text
 * without shipping a headless browser — Codex's `open` action needs a ref_id
 * from a prior search, so it cannot cold-open a URL.
 *
 * Two safeguards matter here:
 *
 *   Private hosts are never forwarded, even when `ssrf.allowRanges` permits
 *   them locally. Handing an internal URL to a third-party renderer is
 *   exfiltration, and it is exactly the case the SSRF guard does not cover
 *   because the request leaves from Jina, not from us.
 *
 *   The free tier is 20 RPM, so calls go through the shared limiter, which
 *   waits rather than failing.
 */

import { GleanError, classifyHttpStatus } from "../errors.ts";
import type { RateLimiter } from "../ratelimit.ts";
import { resolvesPrivately, type Lookup } from "./ssrf.ts";

export const JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_TIMEOUT_MS = 30_000;
const MARKDOWN_MARKER = "Markdown Content:";
const MIN_USEFUL_LENGTH = 100;

export interface JinaOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  lookup?: Lookup;
  rateLimiter?: RateLimiter;
}

export interface JinaResult {
  title: string;
  content: string;
}

function headingTitle(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

/**
 * Returns null when Jina could not produce usable content — the caller then
 * reports the original extraction error, which is more informative than
 * "the fallback also failed".
 */
export async function fetchViaJina(
  targetUrl: string,
  options: JinaOptions = {},
): Promise<JinaResult | null> {
  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return null;
  }

  // Refuse before the URL leaves this process.
  if (await resolvesPrivately(hostname, options.lookup)) {
    throw new GleanError(
      "ssrf",
      `Refusing to send ${hostname} to r.jina.ai: it resolves to a private address.`,
      {
        source: "jina",
        hint: "Jina Reader fetches the page from its own servers, so an internal URL would be disclosed to a third party.",
      },
    );
  }

  await options.rateLimiter?.acquire(options.signal);

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "text/markdown",
      "X-No-Cache": "true",
    };
    // Raises the limit from 20 to 500 RPM when present.
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const response = await fetchImpl(JINA_READER_BASE + targetUrl, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 429 && !options.apiKey) {
        throw new GleanError("quota", "Jina Reader rate limit reached (20 RPM on the free tier).", {
          status: 429,
          source: "jina",
          hint: "Set JINA_API_KEY to raise the limit to 500 RPM, or disable the fallback with fetch.jina.enabled=false.",
        });
      }
      if (classifyHttpStatus(response.status) === "quota") {
        throw new GleanError("quota", `Jina Reader rate limit reached (HTTP ${response.status}).`, {
          status: response.status,
          source: "jina",
        });
      }
      return null;
    }

    const body = await response.text();
    const markerAt = body.indexOf(MARKDOWN_MARKER);
    if (markerAt < 0) return null;

    const markdown = body.slice(markerAt + MARKDOWN_MARKER.length).trim();
    // Jina echoes these when its own render failed; they are not content.
    if (
      markdown.length < MIN_USEFUL_LENGTH ||
      markdown.startsWith("Loading...") ||
      markdown.startsWith("Please enable JavaScript")
    ) {
      return null;
    }

    const fallbackTitle = (() => {
      try {
        return new URL(targetUrl).pathname.split("/").pop() || targetUrl;
      } catch {
        return targetUrl;
      }
    })();

    return { title: headingTitle(markdown) ?? fallbackTitle, content: markdown };
  } catch (error) {
    if (error instanceof GleanError) throw error;
    // A failed fallback should not mask the original error.
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
