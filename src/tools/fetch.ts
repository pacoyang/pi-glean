/**
 * `glean_fetch` — read a URL as markdown.
 *
 * Registered eagerly: fetching needs no credential, so this tool always works.
 *
 * Results are always stored, single URL or many, so a truncated page can be
 * paged through with `glean_get_content` without refetching.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { extractAll, type ExtractDeps } from "../fetch/extract.ts";
import { normalizeFetchParams } from "../fetch/params.ts";
import type { ExtractedContent } from "../fetch/types.ts";
import { CUSTOM_TYPE, generateId, storeResult, stripThumbnails } from "../storage.ts";
import type { RateLimiters } from "../ratelimit.ts";
import { renderFetchResult, toolResultComponent, type ThemeLike } from "../render.ts";

export interface FetchToolDeps {
  config: ResolvedConfig;
  rateLimiters?: RateLimiters;
}

/** Twelve stills is already a lot of context; beyond that the text is better. */
const MAX_IMAGES = 12;

export type MediaBlock =
  | { type: "image"; data: string; mimeType: string }
  | { type: "text"; text: string };

/**
 * Turns extracted frames into content blocks.
 *
 * Each image is followed by a line naming its position: without that the model
 * sees a pile of stills and cannot say which moment any of them shows. A
 * thumbnail stands in only when there are no frames.
 */
export function mediaBlocks(results: ExtractedContent[], max = MAX_IMAGES): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  let count = 0;

  for (const result of results) {
    for (const frame of result.frames ?? []) {
      if (count >= max) return blocks;
      blocks.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
      blocks.push({ type: "text", text: `Frame at ${frame.timestamp}` });
      count++;
    }
    if (!result.frames?.length && result.thumbnail) {
      if (count >= max) return blocks;
      blocks.push({
        type: "image",
        data: result.thumbnail.data,
        mimeType: result.thumbnail.mimeType,
      });
      blocks.push({ type: "text", text: `Thumbnail for ${result.title || result.url}` });
      count++;
    }
  }
  return blocks;
}

function imageCount(blocks: MediaBlock[]): number {
  return blocks.filter((block) => block.type === "image").length;
}

export function buildFetchTool(pi: ExtensionAPI, deps: FetchToolDeps) {
  const { config } = deps;
  const names = config.toolNames;

  return defineTool({
    name: names.fetch,
    label: "Fetch",
    description:
      "Fetch one or more URLs and return the page content as markdown. " +
      "Handles articles, docs, JSON and plain text; PDFs are extracted to text. " +
      "GitHub repository URLs return the file tree and README. " +
      "Long pages are truncated with a pointer to retrieve the rest.",
    promptSnippet: `${names.fetch}: fetch a URL and read it as markdown.`,
    promptGuidelines: [
      `After ${names.search}, use ${names.fetch} on the citations that matter — the search answer ` +
        "is a summary, the page is the source. Quote from the page, not the summary.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "A single URL to fetch." })),
      urls: Type.Optional(
        Type.Array(Type.String(), {
          description: "Several URLs, fetched in parallel (3 at a time).",
        }),
      ),
      forceClone: Type.Optional(
        Type.Boolean({ description: "Clone a GitHub repository that exceeds the size threshold." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description: "Question to focus video analysis on. Pass the user's exact question.",
        }),
      ),
      timestamp: Type.Optional(
        Type.String({
          description: "Video position: '1:23:45', '23:45', '85', or a range '23:41-25:00'.",
        }),
      ),
      frames: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 12,
          description: "Number of video frames to extract.",
        }),
      ),
    }),

    renderResult(result, options, theme: ThemeLike) {
      return toolResultComponent(result, options, theme, renderFetchResult);
    },

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const { urlList, options } = normalizeFetchParams(params);
      if (urlList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: no URL provided." }],
          details: { error: "No URL provided", kind: "schema" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)…` }],
        details: { phase: "fetch", progress: 0, partial: true },
      });

      const extractDeps: ExtractDeps = {
        config,
        ...(deps.rateLimiters ? { rateLimiters: deps.rateLimiters } : {}),
      };
      const results = await extractAll(urlList, extractDeps, {
        ...options,
        ...(signal ? { signal } : {}),
      });

      const successful = results.filter((entry) => !entry.error).length;
      const totalChars = results.reduce((sum, entry) => sum + entry.content.length, 0);

      // Always stored, even for one URL: truncation needs somewhere to page from.
      const responseId = generateId();
      const data = {
        id: responseId,
        type: "fetch" as const,
        timestamp: Date.now(),
        urls: stripThumbnails(results),
      };
      storeResult(responseId, data);
      pi.appendEntry(CUSTOM_TYPE, data);

      if (urlList.length === 1) {
        const result = results[0]!;
        if (result.error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${result.error}` }],
            details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId },
            isError: true,
          };
        }

        const fullLength = result.content.length;
        const truncated = fullLength > config.fetch.maxInlineChars;
        let text = truncated
          ? result.content.slice(0, config.fetch.maxInlineChars)
          : result.content;
        if (truncated) {
          text +=
            `\n\n[Content truncated]\n---\nShowing ${config.fetch.maxInlineChars} of ${fullLength} chars. ` +
            `Use ${names.getContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${config.fetch.maxInlineChars} }) for the next slice.`;
        }

        const media = mediaBlocks(results);
        return {
          content: [{ type: "text" as const, text }, ...media],
          details: {
            urls: urlList,
            urlCount: 1,
            successful: 1,
            totalChars: fullLength,
            title: result.title,
            via: result.via,
            responseId,
            truncated,
            imageCount: imageCount(media),
            ...(result.duration !== undefined ? { duration: result.duration } : {}),
          },
        };
      }

      let text = "## Fetched URLs\n\n";
      for (const { url, title, content, error } of results) {
        text += error
          ? `- ${url}: Error — ${error}\n`
          : `- ${title || url} (${content.length} chars)\n`;
      }
      // A multi-URL fetch never inlines the bodies, so the pointer is always
      // needed here. The single-URL branch above adds it only when truncated.
      text += `\n---\nUse ${names.getContent}({ responseId: "${responseId}", urlIndex: 0 }) to read each one.`;

      const media = mediaBlocks(results);
      return {
        content: [{ type: "text" as const, text }, ...media],
        details: {
          urls: urlList,
          urlCount: urlList.length,
          successful,
          totalChars,
          responseId,
          imageCount: imageCount(media),
        },
      };
    },
  });
}
