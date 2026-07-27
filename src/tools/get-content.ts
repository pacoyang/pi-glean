/**
 * `glean_get_content` — bounded slices of a stored result.
 *
 * Both producers page through here: fetched pages and search answers. The
 * search branch takes offset/limit too — upstream returned the whole thing,
 * which is fine for a list of links but not for a 40 KB synthesized answer.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { formatSources } from "../search/citations.ts";
import { getResult, type QueryResultData, type StoredSearchData } from "../storage.ts";
import type { ExtractedContent } from "../fetch/types.ts";

const MAX_LIMIT = 30_000;

interface SliceRequest {
  offset: number;
  limit: number;
}

/** Renders one slice plus the pointer to the next, when there is one. */
export function sliceWithContinuation(
  body: string,
  request: SliceRequest,
  pointer: (nextOffset: number) => string,
): { text: string; nextOffset: number | null } {
  const end = Math.min(request.offset + request.limit, body.length);
  const text = body.slice(request.offset, end);
  const nextOffset = end < body.length ? end : null;
  return {
    text: nextOffset === null ? text : `${text}\n\n---\n${pointer(nextOffset)}`,
    nextOffset,
  };
}

function renderQuery(data: QueryResultData): string {
  if (data.error) return `## ${data.query}\n\nFAILED: ${data.error}`;
  const sources = formatSources(data.citations);
  return [`## ${data.query} (${data.backend})`, "", data.answer, sources ? `\n${sources}` : ""]
    .join("\n")
    .trimEnd();
}

function selectQuery(
  stored: StoredSearchData,
  query: string | undefined,
  queryIndex: number | undefined,
): { data: QueryResultData; index: number } | { error: string } {
  const queries = stored.queries ?? [];
  if (queries.length === 0) return { error: "Stored result contains no queries" };

  if (queryIndex !== undefined) {
    const data = queries[queryIndex];
    if (!data) {
      return { error: `queryIndex ${queryIndex} is out of range (0..${queries.length - 1})` };
    }
    return { data, index: queryIndex };
  }
  if (query !== undefined) {
    const index = queries.findIndex((entry) => entry.query === query);
    if (index < 0) return { error: `No stored query matching ${JSON.stringify(query)}` };
    return { data: queries[index]!, index };
  }
  return { data: queries[0]!, index: 0 };
}

function selectUrl(
  stored: StoredSearchData,
  url: string | undefined,
  urlIndex: number | undefined,
): { data: ExtractedContent; index: number } | { error: string } {
  const urls = stored.urls ?? [];
  if (urls.length === 0) return { error: "Stored result contains no URLs" };

  if (urlIndex !== undefined) {
    const data = urls[urlIndex];
    if (!data) return { error: `urlIndex ${urlIndex} is out of range (0..${urls.length - 1})` };
    return { data, index: urlIndex };
  }
  if (url !== undefined) {
    const index = urls.findIndex((entry) => entry.url === url);
    if (index < 0) return { error: `No stored URL matching ${JSON.stringify(url)}` };
    return { data: urls[index]!, index };
  }
  return { data: urls[0]!, index: 0 };
}

export function buildGetContentTool(config: ResolvedConfig) {
  const names = config.toolNames;

  return defineTool({
    name: names.getContent,
    label: "Get Content",
    description:
      "Retrieve a bounded slice of a previously stored search answer or fetched page, " +
      `using the responseId returned by ${names.search} or ${names.fetch}. ` +
      "Use offset to continue where the previous slice ended.",
    promptSnippet: `${names.getContent}: page through stored search answers and fetched pages.`,
    parameters: Type.Object({
      responseId: Type.String({ description: "The responseId from an earlier result." }),
      query: Type.Optional(Type.String({ description: "Select a stored query by its text." })),
      queryIndex: Type.Optional(
        Type.Integer({ minimum: 0, description: "Select a stored query by index." }),
      ),
      url: Type.Optional(Type.String({ description: "Select a fetched URL by its address." })),
      urlIndex: Type.Optional(
        Type.Integer({ minimum: 0, description: "Select a fetched URL by index." }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Character offset to start from." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Characters to return (max ${MAX_LIMIT}).`,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const stored = getResult(params.responseId);
      if (!stored) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No stored result for responseId ${JSON.stringify(params.responseId)}. ` +
                "Results expire after an hour and are cleared when the session ends.",
            },
          ],
          details: { error: "Unknown responseId", kind: "not_found" },
          isError: true,
        };
      }

      const offset = params.offset ?? 0;
      const limit = params.limit ?? MAX_LIMIT;

      const selected =
        stored.type === "search"
          ? selectQuery(stored, params.query, params.queryIndex)
          : selectUrl(stored, params.url, params.urlIndex);

      if ("error" in selected) {
        return {
          content: [{ type: "text" as const, text: selected.error }],
          details: { error: selected.error, kind: "invalid-request" },
          isError: true,
        };
      }

      if (stored.type === "fetch") {
        const { data, index } = selected as { data: ExtractedContent; index: number };
        if (data.error) {
          return {
            content: [{ type: "text" as const, text: `${data.url} failed: ${data.error}` }],
            details: { error: data.error, url: data.url, urlIndex: index },
            isError: true,
          };
        }
        if (offset >= data.content.length && data.content.length > 0) {
          const message = `offset ${offset} is past the end of the content (${data.content.length} chars)`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: { error: message, kind: "invalid-request" },
            isError: true,
          };
        }

        const { text, nextOffset } = sliceWithContinuation(
          data.content,
          { offset, limit },
          (next) =>
            `Use ${names.getContent}({ responseId: "${params.responseId}", urlIndex: ${index}, offset: ${next}, limit: ${limit} }) for the next slice.`,
        );
        return {
          content: [{ type: "text" as const, text: `# ${data.title || data.url}\n\n${text}` }],
          details: {
            url: data.url,
            urlIndex: index,
            offset,
            nextOffset,
            totalChars: data.content.length,
          },
        };
      }

      const { data, index } = selected as { data: QueryResultData; index: number };
      const body = renderQuery(data);
      if (offset >= body.length && body.length > 0) {
        const message = `offset ${offset} is past the end of the answer (${body.length} chars)`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: message, kind: "invalid-request" },
          isError: true,
        };
      }

      const { text, nextOffset } = sliceWithContinuation(
        body,
        { offset, limit },
        (next) =>
          `Use ${names.getContent}({ responseId: "${params.responseId}", queryIndex: ${index}, offset: ${next}, limit: ${limit} }) for the next slice.`,
      );
      return {
        content: [{ type: "text" as const, text }],
        details: {
          query: data.query,
          queryIndex: index,
          backend: data.backend,
          offset,
          nextOffset,
          totalChars: body.length,
        },
      };
    },
  });
}
