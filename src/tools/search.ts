/**
 * `glean_search` — one tool over every general-web backend.
 *
 * Registered eagerly: exa needs no credential, so this tool always works and
 * belongs in the first system prompt. A per-backend tool set would instead
 * leave users with a dead tool for every subscription they lack — and the
 * backend cannot be probed at registration time anyway, since `registerTool`
 * runs before any `ctx` exists.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { GleanError, classifyError } from "../errors.ts";
import { formatSources, type Backend, type SearchAnswer } from "../search/citations.ts";
import { PROVIDERS, type ProviderContext } from "../search/providers.ts";
import { routeSearch } from "../search/router.ts";
import { CUSTOM_TYPE, generateId, storeResult, type QueryResultData } from "../storage.ts";
import type { RateLimiters } from "../ratelimit.ts";
import { startBackgroundFetch } from "./prefetch.ts";
import { renderSearchResult, toolResultComponent, type ThemeLike } from "../render.ts";

export interface SearchToolDeps {
  config: ResolvedConfig;
  rateLimiters?: RateLimiters;
}

function sessionIdOf(ctx: ExtensionContext): string | null {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string })?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

/** One query's section of the tool output. */
export function formatQuery(data: QueryResultData, showBackend: boolean): string {
  const header = showBackend ? `## ${data.query} (${data.backend})` : `## ${data.query}`;
  if (data.error) return `${header}\n\nFAILED: ${data.error}`;
  const sources = formatSources(data.citations);
  return [header, "", data.answer, sources ? `\n${sources}` : ""].join("\n").trimEnd();
}

/**
 * Only disambiguate by backend when the same query string appears twice —
 * otherwise the suffix is noise.
 */
export function duplicateQueries(results: QueryResultData[]): Set<string> {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([query]) => query));
}

export function buildSearchTool(pi: ExtensionAPI, deps: SearchToolDeps) {
  const { config } = deps;
  const names = config.toolNames;

  return defineTool({
    name: names.search,
    label: "Web Search",
    description:
      "Search the web and return a synthesized answer with source citations. " +
      "Prefer several queries covering different angles over one broad query — each runs in " +
      "parallel and gets its own answer, so varied phrasing gives much wider coverage. " +
      "Backends are tried in configured order; 'auto' needs no arguments. " +
      "Set includeContent to have the top sources fetched in the background.",
    promptSnippet: `${names.search}: search the web and get a synthesized answer with citations.`,
    promptGuidelines: [
      `Use ${names.search} for anything that depends on current information, then follow up with ` +
        `${names.fetch} on the citations that matter — the answer is a summary, the page is the source.`,
      `For tweets, X posts, or discussion on X, use ${names.xSearch} — not ${names.search}. ` +
        `General web search does not index X well.`,
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: config.search.batchSize,
        description: `One or more search queries run in parallel (max ${config.search.batchSize}).`,
      }),
      backend: Type.Optional(
        StringEnum(["auto", "codex", "xai", "tavily", "perplexity", "exa"] as const, {
          description:
            "Search backend. 'auto' (default) walks the configured order with conditional fallback.",
        }),
      ),
      freshness: Type.Optional(
        StringEnum(["cached", "indexed", "live"] as const, {
          description:
            "codex only. 'live' for time-sensitive facts, 'cached' for stable topics. Ignored elsewhere.",
        }),
      ),
      search_context_size: Type.Optional(
        StringEnum(["low", "medium", "high"] as const, {
          description: "codex only. How much web context to retrieve. Defaults to medium.",
        }),
      ),
      allowed_domains: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "xai and tavily only. Restrict results to these domains; prefix with - to exclude.",
        }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({
          description:
            "Fetch the top cited pages in the background. The answer returns immediately; " +
            "a follow-up message reports when the content is ready.",
        }),
      ),
    }),

    renderResult(result, options, theme: ThemeLike) {
      return toolResultComponent(result, options, theme, renderSearchResult);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const total = params.queries.length;
      let completed = 0;

      const providerCtx: ProviderContext = {
        config,
        modelRegistry: ctx.modelRegistry as ProviderContext["modelRegistry"],
        sessionId: sessionIdOf(ctx),
        ...(signal ? { signal } : {}),
        ...(deps.rateLimiters ? { rateLimiters: deps.rateLimiters } : {}),
      };

      const settled = await Promise.allSettled(
        params.queries.map(async (query) => {
          const options: Parameters<typeof routeSearch>[0] = { query };
          if (params.backend) options.backend = params.backend as Backend | "auto";
          if (params.freshness) options.freshness = params.freshness;
          if (params.search_context_size) options.searchContextSize = params.search_context_size;
          if (params.allowed_domains) options.allowedDomains = params.allowed_domains;
          // Stream deltas only for a single query; interleaved text from a batch
          // would be unreadable, so batches report progress instead.
          if (total === 1 && onUpdate) {
            options.onTextDelta = (delta) => {
              onUpdate({ content: [{ type: "text", text: delta }], details: { partial: true } });
            };
          }

          const answer = await routeSearch(options, providerCtx);
          completed++;
          if (total > 1) {
            onUpdate?.({
              content: [{ type: "text", text: `Searched ${completed}/${total}` }],
              details: { partial: true, completed, total },
            });
          }
          return answer;
        }),
      );

      const results: QueryResultData[] = settled.map((outcome, index) => {
        const query = params.queries[index]!;
        if (outcome.status === "fulfilled") {
          const answer: SearchAnswer = outcome.value;
          return {
            query,
            backend: answer.backend,
            answer: answer.answer,
            citations: answer.citations,
            error: null,
          };
        }
        const classified = classifyError(outcome.reason);
        return {
          query,
          backend: "unknown",
          answer: "",
          citations: [],
          error: classified.displayMessage,
        };
      });

      // Every query failing is a real failure; a partial batch still has value.
      if (results.every((result) => result.error !== null)) {
        const first = settled.find((outcome) => outcome.status === "rejected");
        const reason = first && first.status === "rejected" ? first.reason : undefined;
        const classified =
          reason instanceof GleanError
            ? reason
            : classifyError(reason ?? new Error("Search failed"));
        return {
          content: [{ type: "text" as const, text: classified.displayMessage }],
          details: { error: classified.message, kind: classified.kind, queries: results },
          isError: true,
        };
      }

      const responseId = generateId();
      const data = {
        id: responseId,
        type: "search" as const,
        timestamp: Date.now(),
        queries: results,
      };
      storeResult(responseId, data);
      pi.appendEntry(CUSTOM_TYPE, data);

      const showBackend = duplicateQueries(results).size > 0;
      let text = results.map((result) => formatQuery(result, showBackend)).join("\n\n---\n\n");

      const truncated = text.length > config.fetch.maxInlineChars;
      if (truncated) {
        text =
          `${text.slice(0, config.fetch.maxInlineChars)}\n\n[Truncated]\n` +
          `Use ${names.getContent}({ responseId: "${responseId}", offset: ${config.fetch.maxInlineChars} }) for the rest.`;
      }

      // Started after the answer is assembled and deliberately not awaited: the
      // search returns now, and the agent is woken when the pages land.
      let contentFetchId: string | null = null;
      if (params.includeContent) {
        const urls = [
          ...new Set(results.flatMap((result) => result.citations.map((c) => c.url))),
        ].slice(0, config.search.includeContentLimit);
        contentFetchId = startBackgroundFetch(urls, {
          pi,
          config,
          ...(deps.rateLimiters ? { rateLimiters: deps.rateLimiters } : {}),
        });
        if (contentFetchId) {
          text += `\n\n---\nFetching ${urls.length} cited page(s) in the background; a follow-up message will report when they are ready.`;
        }
      }

      const backends = [...new Set(results.map((r) => r.backend))];
      return {
        content: [{ type: "text" as const, text }],
        details: {
          responseId,
          queryCount: total,
          successful: results.filter((r) => r.error === null).length,
          backend: backends.length === 1 ? backends[0] : backends,
          ...(contentFetchId ? { contentFetchId } : {}),
          // Derived from the provider table rather than stored per result.
          synthesized: backends.every(
            (b) => b !== "unknown" && PROVIDERS[b as Backend]?.synthesized,
          ),
          truncated,
          queries: results,
        },
      };
    },
  });
}
