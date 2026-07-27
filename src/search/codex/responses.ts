/**
 * Codex web search over the streaming Responses API.
 *
 * Returns a synthesized answer plus `url_citation` annotations. Those
 * annotations carry character offsets into the answer, which makes Codex the
 * only backend where a citation can be tied to the exact sentence it supports.
 */

import {
  GleanError,
  classifyError,
  classifyHttpStatus,
  formatHttpErrorBody,
} from "../../errors.ts";
import type { Citation, SearchCall } from "../citations.ts";
import type { CodexTransport } from "./transport.ts";

export type SearchContextSize = "low" | "medium" | "high";
export type Freshness = "cached" | "indexed" | "live";

export interface CodexSearchOptions {
  query: string;
  model: string;
  transport: CodexTransport;
  freshness: Freshness;
  searchContextSize: SearchContextSize;
  sessionId?: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface CodexSearchResult {
  responseId?: string;
  model: string;
  text: string;
  searchCalls: SearchCall[];
  citations: Citation[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * `cached` keeps Codex inside its own index, `indexed` adds the wider indexed
 * corpus, `live` lets it reach the open web.
 */
export function webAccessForFreshness(freshness: Freshness): {
  external: boolean;
  indexed?: true;
} {
  if (freshness === "cached") return { external: false };
  if (freshness === "indexed") return { external: false, indexed: true };
  return { external: true };
}

interface SseEvent {
  type: string;
  data?: unknown;
}

interface OutputText {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface OutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  content?: OutputText[];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface EventData {
  response?: { id?: string; usage?: Usage };
  item?: OutputItem;
  delta?: string;
  error?: { message?: string; code?: string };
}

export async function runCodexSearch(options: CodexSearchOptions): Promise<CodexSearchResult> {
  const { transport, query, model, freshness, searchContextSize, sessionId, signal, onTextDelta } =
    options;

  const headers = transport.buildHeaders("text/event-stream");
  if (sessionId) headers.set("session-id", sessionId);

  const access = webAccessForFreshness(freshness);
  const webSearchTool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: access.external,
    search_context_size: searchContextSize,
  };
  if (access.indexed) webSearchTool.indexed_web_access = true;

  const response = await transport.fetch(transport.endpoint("responses"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions:
        "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [webSearchTool],
      tool_choice: "required",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
    }),
    signal,
  });

  if (!response.ok) {
    const body = formatHttpErrorBody(await response.text());
    throw new GleanError(
      classifyHttpStatus(response.status),
      `Codex search failed: HTTP ${response.status}: ${body}`,
      { status: response.status, source: "codex" },
    );
  }
  if (!response.body) {
    throw new GleanError("invalid-response", "Codex returned no response body", {
      source: "codex",
    });
  }

  let responseId: string | undefined;
  let usage: Usage | undefined;
  let streamedText = "";
  const messageParts: string[] = [];
  const searchCalls = new Map<string, SearchCall>();
  const citations = new Map<string, Citation>();

  for await (const event of parseSse(response.body)) {
    const data = event.data as EventData | undefined;
    if (!data) continue;

    switch (event.type) {
      case "response.created":
        responseId = data.response?.id;
        break;
      case "response.output_text.delta": {
        const delta = data.delta ?? "";
        streamedText += delta;
        onTextDelta?.(delta);
        break;
      }
      case "response.output_item.added":
        if (data.item?.type === "web_search_call" && data.item.id) {
          searchCalls.set(data.item.id, { status: data.item.status });
        }
        break;
      case "response.output_item.done":
        collectOutputItem(data.item, searchCalls, messageParts, citations);
        break;
      case "response.completed":
        usage = data.response?.usage;
        break;
      case "response.failed": {
        const message = data.error?.message ?? data.error?.code ?? "Codex web search failed";
        throw classifyError(new Error(message), "codex");
      }
      default:
        break;
    }
  }

  const result: CodexSearchResult = {
    model,
    // Completed message items are authoritative; deltas are the live preview.
    text: messageParts.join("") || streamedText,
    searchCalls: [...searchCalls.values()],
    citations: [...citations.values()],
  };
  if (responseId !== undefined) result.responseId = responseId;
  if (usage) {
    result.usage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    };
  }
  return result;
}

function collectOutputItem(
  item: OutputItem | undefined,
  searchCalls: Map<string, SearchCall>,
  messageParts: string[],
  citations: Map<string, Citation>,
): void {
  if (!item) return;

  if (item.type === "web_search_call") {
    const key = item.id ?? `search-${searchCalls.size + 1}`;
    const call: SearchCall = {};
    const query = item.action?.query ?? item.action?.queries?.join(", ");
    if (query !== undefined) call.query = query;
    if (item.action?.url !== undefined) call.url = item.action.url;
    if (item.status !== undefined) call.status = item.status;
    searchCalls.set(key, call);
    return;
  }

  if (item.type !== "message" || item.role !== "assistant") return;

  for (const part of item.content ?? []) {
    if (part.type !== "output_text") continue;
    messageParts.push(part.text ?? "");
    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== "url_citation" || !annotation.url) continue;
      const citation: Citation = { url: annotation.url };
      if (annotation.title !== undefined) citation.title = annotation.title;
      if (annotation.start_index !== undefined) citation.startIndex = annotation.start_index;
      if (annotation.end_index !== undefined) citation.endIndex = annotation.end_index;
      citations.set(annotation.url, citation);
    }
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let drained = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = findSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const event = parseFrame(frame);
        if (event) yield event;
        separator = findSeparator(buffer);
      }
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  buffer += decoder.decode();
  const trailing = parseFrame(buffer);
  if (trailing) yield trailing;
}

function findSeparator(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function parseFrame(frame: string): SseEvent | undefined {
  let type = "";
  const dataLines: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return undefined;

  try {
    return { type, data: JSON.parse(raw) };
  } catch {
    return { type };
  }
}
