/**
 * xAI Responses API.
 *
 * Two distinct server-side tools live here and they are not interchangeable:
 *   web_search  — general web, backed by a multi-agent model
 *   x_search    — X (Twitter) corpus, backed by a reasoning model, date-filterable
 *
 * That is why `glean_x_search` is a separate tool rather than a backend of
 * `glean_search`: it changes the corpus, not the vendor.
 */

import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../../errors.ts";
import type { Citation, SearchCall } from "../citations.ts";
import {
  DEFAULT_WEB_SEARCH_MODEL,
  DEFAULT_X_SEARCH_MODEL,
  SEARCH_TIMEOUT_MS,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_VERSION,
  USER_AGENT,
  XAI_API_BASE,
} from "./constants.ts";

export interface XaiResponsesResult {
  model?: string;
  output?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
  citations?: string[];
  server_side_tool_usage?: Record<string, number>;
}

export interface XaiCallOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string | null;
  /** x_search only: routes follow-ups in a conversation to the same shard. */
  sendSessionAffinity?: boolean;
}

/** Grok emits `https://example.com[[1]](…)` with no space; readers need one. */
const CITATION_GLUE = /((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g;

export function glueCitationSpacing(text: string): string {
  return text.replace(CITATION_GLUE, "$1 $2");
}

/** True when requests should carry the Grok CLI identity rather than plain API auth. */
export function isGrokCliProxyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "cli-chat-proxy.grok.com";
  } catch {
    return baseUrl.includes("cli-chat-proxy.grok.com");
  }
}

/**
 * Transport headers for one request.
 *
 * Against `api.x.ai` there is nothing to add beyond the bearer token. The CLI
 * proxy authenticates the *client* as well, so it needs the full Grok CLI
 * identity — without it the connection is accepted and then never answered.
 */
export function xaiRequestHeaders(
  modelId: string,
  baseUrl: string | undefined,
  sessionId?: string | null,
): Record<string, string> {
  if (!isGrokCliProxyBaseUrl(baseUrl)) return { "User-Agent": USER_AGENT };

  const headers: Record<string, string> = {
    "User-Agent": `${GROK_CLI_CLIENT_IDENTIFIER}/${GROK_CLI_VERSION}`,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "interactive",
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH,
    "x-authenticateresponse": "authenticate-response",
    "x-grok-model-override": modelId,
  };
  if (sessionId) headers["x-grok-conv-id"] = sessionId;
  return headers;
}

export function clampPromptCacheKey(key: string | undefined | null, max = 64): string | undefined {
  if (key == null) return undefined;
  const trimmed = String(key).trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : chars.slice(0, max).join("");
}

export async function callXaiResponses(
  apiKey: string,
  body: Record<string, unknown>,
  options: XaiCallOptions = {},
): Promise<XaiResponsesResult> {
  const baseUrl = (options.baseUrl ?? XAI_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

  if (options.sendSessionAffinity) {
    const key = clampPromptCacheKey(options.sessionId);
    if (key) body.prompt_cache_key = key;
  }

  // Two abort sources: the caller's signal and our own timeout. Distinguish
  // them afterwards so "cancelled" is never reported as "timed out".
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...xaiRequestHeaders(String(body.model ?? ""), baseUrl, options.sessionId),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GleanError(
        classifyHttpStatus(response.status),
        `xAI Responses API HTTP ${response.status}: ${formatHttpErrorBody(text)}`,
        { status: response.status, source: "xai" },
      );
    }
    return (await response.json()) as XaiResponsesResult;
  } catch (error) {
    if (error instanceof GleanError) throw error;
    if (controller.signal.aborted && options.signal?.aborted) {
      throw new GleanError("aborted", "xAI search was cancelled", { source: "xai" });
    }
    if (controller.signal.aborted) {
      throw new GleanError("timeout", `xAI search timed out after ${timeoutMs}ms`, {
        source: "xai",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export interface XaiSearchResult {
  text: string;
  citations: Citation[];
  searchCalls: SearchCall[];
  raw: XaiResponsesResult;
}

/** Pulls the assistant text and tool-call records out of the output array. */
export function extractOutput(result: XaiResponsesResult): {
  text: string;
  searchCalls: SearchCall[];
} {
  const items = Array.isArray(result.output) ? result.output : [];
  const textParts: string[] = [];
  const searchCalls: SearchCall[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "output_text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          textParts.push((part as { text: string }).text);
        }
      }
      continue;
    }

    if (item.type === "web_search_call" || item.type === "x_search_call") {
      const action = item.action as { query?: string; url?: string } | undefined;
      const call: SearchCall = {};
      if (action?.query !== undefined) call.query = action.query;
      if (action?.url !== undefined) call.url = action.url;
      if (typeof item.status === "string") call.status = item.status;
      searchCalls.push(call);
    }
  }

  return { text: glueCitationSpacing(textParts.join("\n")), searchCalls };
}

/**
 * xAI returns bare URLs with no offsets, so a citation's supporting sentence has
 * to be recovered from the inline `[[n]](url)` markers in the answer.
 */
export function citationsFrom(result: XaiResponsesResult, text: string): Citation[] {
  const urls = Array.isArray(result.citations) ? result.citations : [];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);

  return urls
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url) => {
      const citation: Citation = { url };
      const sentence = sentences.find((s) => s.includes(url));
      if (sentence) {
        const start = text.indexOf(sentence);
        if (start >= 0) {
          citation.startIndex = start;
          citation.endIndex = start + sentence.length;
        }
      }
      try {
        citation.title = new URL(url).hostname;
      } catch {
        // Leave the title unset rather than inventing one.
      }
      return citation;
    });
}

export async function runXaiWebSearch(
  apiKey: string,
  params: { query: string; allowedDomains?: string[]; model?: string },
  options: XaiCallOptions = {},
): Promise<XaiSearchResult> {
  const query = params.query.trim();
  if (!query) throw new GleanError("schema", "query is required", { source: "xai" });

  const tool: Record<string, unknown> = { type: "web_search" };
  if (params.allowedDomains?.length) tool.filters = { allowed_domains: params.allowedDomains };

  const result = await callXaiResponses(
    apiKey,
    {
      model: params.model?.trim() || DEFAULT_WEB_SEARCH_MODEL,
      input: query,
      tools: [tool],
      store: false,
      temperature: 0.1,
      top_p: 0.95,
      max_output_tokens: 8192,
    },
    options,
  );

  const { text, searchCalls } = extractOutput(result);
  return { text, searchCalls, citations: citationsFrom(result, text), raw: result };
}

export async function runXSearch(
  apiKey: string,
  params: { query: string; fromDate?: string; toDate?: string; model?: string },
  options: XaiCallOptions = {},
): Promise<XaiSearchResult> {
  const query = params.query.trim();
  if (!query) throw new GleanError("schema", "query is required", { source: "xai" });

  const tool: Record<string, unknown> = { type: "x_search" };
  if (params.fromDate?.trim()) tool.from_date = params.fromDate.trim();
  if (params.toDate?.trim()) tool.to_date = params.toDate.trim();

  const result = await callXaiResponses(
    apiKey,
    {
      model: params.model?.trim() || DEFAULT_X_SEARCH_MODEL,
      input: [{ role: "user", content: query }],
      tools: [tool],
      store: false,
    },
    { ...options, sendSessionAffinity: true },
  );

  const { text, searchCalls } = extractOutput(result);
  return { text, searchCalls, citations: citationsFrom(result, text), raw: result };
}
