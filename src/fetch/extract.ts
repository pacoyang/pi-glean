/**
 * URL → markdown.
 *
 * Local extraction first (linkedom parses the HTML, Readability finds the
 * article, turndown converts it), then Jina Reader when that yields nothing
 * usable — typically a client-rendered page, where the markup holds no text.
 *
 * There is no headless browser anywhere in this package; Jina is how a
 * JS-rendered page becomes readable.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import TurndownService from "turndown";
import type { ResolvedConfig } from "../config.ts";
import { GleanError, classifyError } from "../errors.ts";
import { activityMonitor } from "../activity.ts";
import type { RateLimiters } from "../ratelimit.ts";
import { fetchViaJina } from "./jina.ts";
import { extractRSCContent } from "./rsc.ts";
import { fetchRemoteUrl, type Lookup, validateRemoteUrl } from "./ssrf.ts";
import type { ExtractedContent, ExtractOptions } from "./types.ts";

/** Three at a time: enough to hide latency, few enough to stay polite. */
const CONCURRENCY = 3;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;

/**
 * Failures the Jina fallback cannot help with — retrying them would just cost
 * a round trip and confuse the error.
 */
const NON_RECOVERABLE = ["Unsupported content type", "Response too large"];

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const limit = pLimit(CONCURRENCY);

export interface ExtractDeps {
  config: ResolvedConfig;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  rateLimiters?: RateLimiters;
}

/**
 * Heuristic for "the markup has no content because a script would have written
 * it": almost no body text, but plenty of scripts.
 */
export function isLikelyJsRendered(html: string): boolean {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!body) return false;
  const text = body[1]!.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  const scriptCount = (html.match(/<script/gi) ?? []).length;
  return text.trim().length < MIN_USEFUL_CONTENT && scriptCount > 3;
}

export function isPdf(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
  } catch {
    return url;
  }
}

function failure(url: string, error: string): ExtractedContent {
  return { url, title: "", content: "", error };
}

async function extractViaHttp(
  url: string,
  deps: ExtractDeps,
  options: ExtractOptions,
): Promise<ExtractedContent> {
  const { config } = deps;
  const timeoutMs = options.timeoutMs ?? config.fetch.timeoutMs;
  const activityId = activityMonitor.logStart({ type: "fetch", url });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchRemoteUrl(
      url,
      { headers: BROWSER_HEADERS, signal: controller.signal },
      {
        allowRanges: config.ssrf.allowRanges,
        trustEnvProxy: config.ssrf.trustEnvProxy,
        domainPolicy: config.fetch.domainPolicy,
        ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      },
    );

    if (!response.ok) {
      activityMonitor.logComplete(activityId, response.status);
      return failure(url, `HTTP ${response.status}: ${response.statusText || "request failed"}`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (isPdf(url, contentType)) {
      activityMonitor.logComplete(activityId, response.status, "pdf");
      const { extractPdf } = await import("./pdf.ts");
      return extractPdf(await response.arrayBuffer(), url, config.pdf);
    }

    if (/^(application\/octet-stream|image\/|audio\/|video\/|application\/zip)/.test(contentType)) {
      activityMonitor.logComplete(activityId, response.status);
      return failure(url, `Unsupported content type: ${contentType}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_HTML_BYTES) {
      activityMonitor.logComplete(activityId, response.status);
      return failure(url, `Response too large: ${declaredLength} bytes`);
    }

    const text = await response.text();
    if (text.length > MAX_HTML_BYTES) {
      activityMonitor.logComplete(activityId, response.status);
      return failure(url, `Response too large: ${text.length} bytes`);
    }

    const isHtml = /text\/html|application\/xhtml\+xml/.test(contentType);
    if (!isHtml) {
      activityMonitor.logComplete(activityId, response.status, "raw");
      return { url, title: titleFromUrl(url), content: text, error: null, via: "raw" };
    }

    const { document } = parseHTML(text);
    const article = new Readability(document as unknown as Document).parse();

    if (!article) {
      // Next.js ships content as flight data rather than markup.
      const rsc = extractRSCContent(text);
      if (rsc) {
        activityMonitor.logComplete(activityId, response.status, "rsc");
        return { url, title: rsc.title, content: rsc.content, error: null, via: "rsc" };
      }
      activityMonitor.logComplete(activityId, response.status);
      return failure(
        url,
        isLikelyJsRendered(text)
          ? "Page appears to be JavaScript-rendered (content loads dynamically)"
          : "Could not extract readable content from HTML structure",
      );
    }

    const markdown = turndown.turndown(article.content ?? "");
    if (markdown.length < MIN_USEFUL_CONTENT) {
      activityMonitor.logComplete(activityId, response.status);
      return failure(
        url,
        isLikelyJsRendered(text)
          ? "Page appears to be JavaScript-rendered (content loads dynamically)"
          : "Extracted content appears incomplete",
      );
    }

    activityMonitor.logComplete(activityId, response.status, "http");
    return {
      url,
      title: article.title ?? titleFromUrl(url),
      content: markdown,
      error: null,
      via: "http",
    };
  } catch (error) {
    const classified = classifyError(error, "fetch");
    if (classified.kind === "aborted") activityMonitor.logComplete(activityId, 0);
    else activityMonitor.logError(activityId, classified.message);
    return failure(url, classified.message);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fetch and convert a single URL, applying the fallback chain. */
export async function extractUrl(
  url: string,
  deps: ExtractDeps,
  options: ExtractOptions = {},
): Promise<ExtractedContent> {
  const { config } = deps;

  // Reject before anything leaves the process, so a prompt-injected internal
  // URL never even reaches the fetch layer.
  try {
    await validateRemoteUrl(url, {
      allowRanges: config.ssrf.allowRanges,
      trustEnvProxy: config.ssrf.trustEnvProxy,
      domainPolicy: config.fetch.domainPolicy,
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
    });
  } catch (error) {
    return failure(url, error instanceof Error ? error.message : String(error));
  }

  // GitHub code URLs are worth cloning rather than scraping: the agent gets a
  // real tree and a path it can read and grep. Non-code pages (issues, wiki)
  // return null here and fall through to the HTML path.
  if (config.github.enabled) {
    const { extractGitHub } = await import("../github/extract.ts");
    const repo = await extractGitHub(url, {
      config: config.github,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.forceClone !== undefined ? { forceClone: options.forceClone } : {}),
    });
    if (repo) return repo;
  }

  const direct = await extractViaHttp(url, deps, options);
  if (!direct.error) return direct;
  if (NON_RECOVERABLE.some((prefix) => direct.error!.startsWith(prefix))) return direct;
  if (!config.fetch.jina.enabled) return direct;

  const activityId = activityMonitor.logStart({ type: "api", url: `jina: ${url}` });
  try {
    const jina = await fetchViaJina(url, {
      ...(config.fetch.jina.apiKey ? { apiKey: config.fetch.jina.apiKey } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.rateLimiters?.jina ? { rateLimiter: deps.rateLimiters.jina } : {}),
    });
    if (jina) {
      activityMonitor.logComplete(activityId, 200, "jina");
      return { url, title: jina.title, content: jina.content, error: null, via: "jina" };
    }
    activityMonitor.logComplete(activityId, 0, "jina");
  } catch (error) {
    const classified = error instanceof GleanError ? error : classifyError(error, "jina");
    activityMonitor.logError(activityId, classified.message);
    // An SSRF refusal is a decision worth surfacing, not a quiet fallback miss.
    if (classified.kind === "ssrf") return failure(url, classified.displayMessage);
  }

  return {
    ...direct,
    error: `${direct.error}\n\nThe page could not be read directly or via Jina Reader. Try searching for the topic instead.`,
  };
}

/** Fetch several URLs, capped at three concurrent requests. */
export async function extractAll(
  urls: string[],
  deps: ExtractDeps,
  options: ExtractOptions = {},
): Promise<ExtractedContent[]> {
  return Promise.all(urls.map((url) => limit(() => extractUrl(url, deps, options))));
}
