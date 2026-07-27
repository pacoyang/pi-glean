/**
 * Exa search over the public MCP endpoint.
 *
 * This is the only backend that needs no credential at all — `mcp.exa.ai`
 * accepts an unauthenticated JSON-RPC call — which is what lets pi-glean work
 * out of the box with nothing configured.
 *
 * Exa is also the only backend that returns page *text* rather than a
 * synthesized answer, so `synthesized` is false for it in the provider table.
 * That is not a trap the way concatenated snippets would be: the content is
 * complete, just unsummarized.
 *
 * Only the MCP path is implemented; Exa's direct API needs a key and would add
 * nothing this does not already cover.
 */

import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import type { Citation } from "./citations.ts";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TOOL_NAME = "web_search_exa";
const DEFAULT_TIMEOUT_MS = 60_000;

interface McpContent {
  type?: string;
  text?: string;
}

interface McpRpcResponse {
  result?: { content?: McpContent[]; isError?: boolean };
  error?: { code?: number; message?: string };
}

export interface ExaSearchOptions {
  mcpUrl?: string;
  numResults?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExaSearchResult {
  text: string;
  citations: Citation[];
  raw: unknown;
}

/**
 * The endpoint answers with either a plain JSON body or an SSE stream, so both
 * framings have to be accepted.
 */
function parseRpcBody(body: string): McpRpcResponse {
  const candidates: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
  }
  candidates.push(body);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as McpRpcResponse;
      if (parsed?.result || parsed?.error) return parsed;
    } catch {
      // Try the next framing.
    }
  }
  throw new GleanError("invalid-response", "Exa MCP returned an empty response", { source: "exa" });
}

export async function callExaMcp(
  toolName: string,
  args: Record<string, unknown>,
  options: ExaSearchOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(options.mcpUrl ?? EXA_MCP_URL, {
      method: "POST",
      // No Authorization header — deliberately. This endpoint is unauthenticated.
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GleanError(
        classifyHttpStatus(response.status),
        `Exa MCP error ${response.status}: ${formatHttpErrorBody(text, 300)}`,
        { status: response.status, source: "exa" },
      );
    }

    const parsed = parseRpcBody(await response.text());

    if (parsed.error) {
      const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
      throw new GleanError(
        "invalid-response",
        `Exa MCP error${code}: ${parsed.error.message || "Unknown error"}`,
        { source: "exa" },
      );
    }
    if (parsed.result?.isError) {
      const message = parsed.result.content?.find((item) => item.type === "text")?.text?.trim();
      throw new GleanError("invalid-response", message || "Exa MCP returned an error", {
        source: "exa",
      });
    }

    const text = parsed.result?.content?.find(
      (item) =>
        item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
    )?.text;
    if (!text) {
      throw new GleanError("invalid-response", "Exa MCP returned empty content", { source: "exa" });
    }
    return text;
  } catch (error) {
    if (error instanceof GleanError) throw error;
    if (controller.signal.aborted && options.signal?.aborted) {
      throw new GleanError("aborted", "Exa search was cancelled", { source: "exa" });
    }
    if (controller.signal.aborted) {
      throw new GleanError("timeout", `Exa search timed out after ${timeoutMs}ms`, {
        source: "exa",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Exa's MCP tool returns `Title: … / URL: … / <text>` blocks. */
export function parseExaBlocks(text: string): Citation[] {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  const citations: Citation[] = [];
  for (const block of blocks) {
    const url = block.match(/^URL: (.+)$/m)?.[1]?.trim();
    if (!url) continue;
    const citation: Citation = { url };
    const title = block.match(/^Title: (.+)$/m)?.[1]?.trim();
    if (title) citation.title = title;
    citations.push(citation);
  }
  return citations;
}

export async function runExaSearch(
  query: string,
  options: ExaSearchOptions = {},
): Promise<ExaSearchResult> {
  const text = await callExaMcp(TOOL_NAME, { query, numResults: options.numResults ?? 5 }, options);
  return { text, citations: parseExaBlocks(text), raw: text };
}
