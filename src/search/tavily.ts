/**
 * Tavily search — a synthesized-answer backend for users without a ChatGPT or
 * xAI subscription. Registered only when a key is configured; otherwise the
 * router skips it silently.
 */

import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import { redactCredential } from "../credentials.ts";
import type { Citation } from "./citations.ts";

const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 60_000;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

export interface TavilySearchOptions {
  numResults?: number;
  allowedDomains?: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TavilySearchResult {
  text: string;
  citations: Citation[];
  raw: unknown;
}

/** A leading `-` marks a domain to exclude, matching the upstream convention. */
export function splitDomainFilter(domains: string[] | undefined): {
  include_domains?: string[];
  exclude_domains?: string[];
} {
  if (!domains?.length) return {};
  const include: string[] = [];
  const exclude: string[] = [];
  for (const entry of domains) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("-")) exclude.push(trimmed.slice(1));
    else include.push(trimmed);
  }
  const out: { include_domains?: string[]; exclude_domains?: string[] } = {};
  if (include.length) out.include_domains = include;
  if (exclude.length) out.exclude_domains = exclude;
  return out;
}

export async function runTavilySearch(
  apiKey: string,
  query: string,
  options: TavilySearchOptions = {},
): Promise<TavilySearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(TAVILY_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: options.numResults ?? 5,
        // Server-side synthesis is the reason this backend earns its place.
        include_answer: "basic",
        include_raw_content: false,
        ...splitDomainFilter(options.allowedDomains),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = redactCredential(await response.text().catch(() => ""), apiKey);
      throw new GleanError(
        classifyHttpStatus(response.status),
        `Tavily API error ${response.status}: ${formatHttpErrorBody(text, 300)}`,
        { status: response.status, source: "tavily" },
      );
    }

    let data: TavilyResponse;
    try {
      data = (await response.json()) as TavilyResponse;
    } catch (error) {
      throw new GleanError(
        "invalid-response",
        `Tavily returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { source: "tavily" },
      );
    }

    const citations: Citation[] = [];
    for (const result of data.results ?? []) {
      if (!result.url) continue;
      const citation: Citation = { url: result.url };
      if (result.title) citation.title = result.title;
      citations.push(citation);
    }

    return { text: typeof data.answer === "string" ? data.answer : "", citations, raw: data };
  } catch (error) {
    if (error instanceof GleanError) throw error;
    if (controller.signal.aborted && options.signal?.aborted) {
      throw new GleanError("aborted", "Tavily search was cancelled", { source: "tavily" });
    }
    if (controller.signal.aborted) {
      throw new GleanError("timeout", `Tavily search timed out after ${timeoutMs}ms`, {
        source: "tavily",
      });
    }
    // Never let a raw error carry the key into a log or the model's context.
    const message = redactCredential(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    throw new GleanError("network", message, { source: "tavily", cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
