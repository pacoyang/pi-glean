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
import { hostnameOf, type Citation, type SearchCall } from "../citations.ts";
import {
  DEFAULT_WEB_SEARCH_MODEL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_VERSION,
  DEFAULT_X_SEARCH_MODEL,
  SEARCH_TIMEOUT_MS,
  USER_AGENT,
  GROK_CLI_PROXY_HOST,
} from "./constants.ts";
import { XAI_API_VARIANT } from "./auth.ts";

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

/** True when the host authenticates the client as well as the token. */
export function isGrokCliProxyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === GROK_CLI_PROXY_HOST;
  } catch {
    return baseUrl.includes(GROK_CLI_PROXY_HOST);
  }
}

/**
 * Transport headers for one request.
 *
 * `api.x.ai` needs nothing beyond the bearer token. The Grok CLI proxy checks
 * the client identity too, and silently stalls without it, so a request routed
 * there carries the CLI's own headers.
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
  const baseUrl = (options.baseUrl ?? XAI_API_VARIANT.baseUrl).replace(/\/+$/, "");
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
      // Pinned model names make an upstream rename our problem; the hint below
      // names the override rather than leaving a bare 400.
      const unknownModel = /model not found/i.test(text);
      throw new GleanError(
        classifyHttpStatus(response.status),
        `xAI Responses API HTTP ${response.status}: ${formatHttpErrorBody(text)}`,
        {
          status: response.status,
          source: "xai",
          ...(unknownModel
            ? {
                hint:
                  "Set search.xai.webSearchModel (or xSearchModel) in pi-glean.json. Note that " +
                  "the /v1/models listing is not authoritative — it omits working aliases — so " +
                  "a name absent from it may still be accepted.",
              }
            : {}),
        },
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
  annotations: Citation[];
} {
  const items = Array.isArray(result.output) ? result.output : [];
  const textParts: string[] = [];
  const searchCalls: SearchCall[] = [];
  const annotations: Citation[] = [];

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
          annotations.push(...citationsFromAnnotations(part));
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
      continue;
    }

    // x_search reports through `custom_tool_call` rather than `x_search_call`:
    // the model fans out to `x_semantic_search` / `x_keyword_search`, each
    // carrying its arguments as a JSON string. Without this every X search
    // reported zero search calls despite making a dozen.
    if (item.type === "custom_tool_call" && typeof item.name === "string") {
      if (!/search/i.test(item.name)) continue;
      const call: SearchCall = {};
      if (typeof item.input === "string") {
        try {
          const args = JSON.parse(item.input) as { query?: unknown };
          if (typeof args.query === "string") call.query = args.query;
        } catch {
          // A tool call we cannot read still counts as a call having happened.
        }
      }
      if (typeof item.status === "string") call.status = item.status;
      searchCalls.push(call);
    }
  }

  return { text: glueCitationSpacing(textParts.join("\n")), searchCalls, annotations };
}

/**
 * Reads `url_citation` annotations off one message part.
 *
 * This is how live responses carry sources — the top-level `citations` array is
 * absent from them entirely. `title` is only the inline marker number ("1"),
 * so the hostname is used instead.
 *
 * Offsets are deliberately not carried over. xAI's span the `[[1]](url)` marker
 * rather than the prose, which is the opposite of what Codex reports, and
 * nothing reads the field; normalising the two would mean guessing sentence
 * boundaries for no consumer.
 */
function citationsFromAnnotations(part: unknown): Citation[] {
  const raw = (part as { annotations?: unknown })?.annotations;
  if (!Array.isArray(raw)) return [];

  const citations: Citation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    if (a.type !== "url_citation" || typeof a.url !== "string" || !a.url) continue;

    const citation: Citation = { url: a.url };
    // A purely numeric title is the inline marker, not a name.
    if (typeof a.title === "string" && a.title.trim() && !/^\d+$/.test(a.title.trim())) {
      citation.title = a.title.trim();
    } else {
      const host = hostnameOf(a.url);
      if (host) citation.title = host;
    }
    citations.push(citation);
  }
  return citations;
}

/**
 * Citations for one answer.
 *
 * Annotations are what live responses use; the top-level `citations` array is
 * the older, offset-free shape that some responses still send.
 */
export function citationsFrom(
  result: XaiResponsesResult,
  annotations: Citation[] = [],
): Citation[] {
  if (annotations.length > 0) return annotations;
  if (!Array.isArray(result.citations)) return [];

  return result.citations
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url) => {
      const citation: Citation = { url };
      const host = hostnameOf(url);
      if (host) citation.title = host;
      return citation;
    });
}

/**
 * Rejects a reply that never actually searched.
 *
 * Observed against `cli-chat-proxy.grok.com`, which accepts a `web_search` tool
 * and quietly ignores it: the model answers "I'll look that up" from memory and
 * the response carries no search call and no citation. Handing that back as a
 * search result is the worst available outcome — it looks like an answer, has
 * no sources, and may be entirely invented.
 *
 * Both signals have to be absent. A genuine search that happens to surface no
 * citation still records the call it made.
 */
function assertSearched(
  result: { searchCalls: SearchCall[]; citations: Citation[]; raw: unknown },
  endpoint: string,
): void {
  // xAI reports this itself, which beats inferring it from what we managed to
  // parse: the proxy echoes `tools: []` and `num_server_side_tools_used: 0`
  // even though a web_search tool was sent. Trust the count when it is present.
  const used = (result.raw as { usage?: { num_server_side_tools_used?: unknown } })?.usage
    ?.num_server_side_tools_used;
  if (typeof used === "number") {
    if (used > 0) return;
  } else if (result.searchCalls.length > 0 || result.citations.length > 0) {
    return;
  }
  throw new GleanError("invalid-response", "xAI answered without performing a search.", {
    source: "xai",
    hint:
      `The endpoint at ${endpoint} accepted the request but did not run the search tool, ` +
      "so the reply is the model's own recollection rather than sourced results. " +
      "Point search.xai.baseUrl at an endpoint that supports the Responses search tools.",
  });
}

/**
 * Shared tail of both search calls.
 *
 * Extracted so the unsearched-answer guard cannot be forgotten by whatever
 * search function is added next — it is the one step that turns a plausible
 * non-answer into an error.
 */
function toSearchResult(result: XaiResponsesResult, options: XaiCallOptions): XaiSearchResult {
  const { text, searchCalls, annotations } = extractOutput(result);
  const citations = citationsFrom(result, annotations);
  assertSearched(
    { searchCalls, citations, raw: result },
    options.baseUrl ?? XAI_API_VARIANT.baseUrl,
  );
  return { text, searchCalls, citations, raw: result };
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

  return toSearchResult(result, options);
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

  return toSearchResult(result, options);
}
