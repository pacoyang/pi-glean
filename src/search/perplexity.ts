/**
 * Perplexity search.
 *
 * Its quota is low enough that bursts hit it easily, so calls go through the
 * shared sliding-window limiter — which waits rather than failing, and reports
 * headroom to the activity widget.
 */

import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import { redactCredential } from "../credentials.ts";
import type { RateLimiter } from "../ratelimit.ts";
import type { Citation } from "./citations.ts";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 60_000;

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ title?: string; url?: string }>;
}

export interface PerplexitySearchOptions {
  model?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  rateLimiter?: RateLimiter;
}

export interface PerplexitySearchResult {
  text: string;
  citations: Citation[];
  raw: unknown;
}

export async function runPerplexitySearch(
  apiKey: string,
  query: string,
  options: PerplexitySearchOptions = {},
): Promise<PerplexitySearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Wait for a slot before spending the request; the caller sees latency, not an error.
  await options.rateLimiter?.acquire(options.signal);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(PERPLEXITY_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model?.trim() || DEFAULT_MODEL,
        messages: [{ role: "user", content: query }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = redactCredential(await response.text().catch(() => ""), apiKey);
      throw new GleanError(
        classifyHttpStatus(response.status),
        `Perplexity API error ${response.status}: ${formatHttpErrorBody(text, 300)}`,
        { status: response.status, source: "perplexity" },
      );
    }

    let data: PerplexityResponse;
    try {
      data = (await response.json()) as PerplexityResponse;
    } catch (error) {
      throw new GleanError(
        "invalid-response",
        `Perplexity returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { source: "perplexity" },
      );
    }

    const text = data.choices?.[0]?.message?.content ?? "";

    // Newer responses carry titled search_results; older ones only bare URLs.
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const result of data.search_results ?? []) {
      if (!result.url || seen.has(result.url)) continue;
      seen.add(result.url);
      const citation: Citation = { url: result.url };
      if (result.title) citation.title = result.title;
      citations.push(citation);
    }
    for (const url of data.citations ?? []) {
      if (typeof url !== "string" || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url });
    }

    return { text, citations, raw: data };
  } catch (error) {
    if (error instanceof GleanError) throw error;
    if (controller.signal.aborted && options.signal?.aborted) {
      throw new GleanError("aborted", "Perplexity search was cancelled", { source: "perplexity" });
    }
    if (controller.signal.aborted) {
      throw new GleanError("timeout", `Perplexity search timed out after ${timeoutMs}ms`, {
        source: "perplexity",
      });
    }
    const message = redactCredential(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    throw new GleanError("network", message, { source: "perplexity", cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
