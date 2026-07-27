/**
 * `glean_x_search` — search X (Twitter) posts.
 *
 * Kept separate from `glean_search` because it changes the *corpus*, not the
 * vendor: xAI exposes `web_search` and `x_search` as different server-side
 * tools with different models. General web search covers X badly — the site
 * blocks crawlers, so engines hold little and stale content — which means a
 * model that reaches for the wrong tool gets second-hand reporting *about*
 * posts instead of the posts.
 *
 * Registered from `session_start` rather than at load time, once xAI auth is
 * confirmed. Without that check, everyone lacking an xAI subscription would
 * carry a tool that can only fail, costing prompt tokens and inviting wrong
 * calls.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { GleanError, classifyError } from "../errors.ts";
import { formatSources } from "../search/citations.ts";
import { CUSTOM_TYPE, generateId, storeResult } from "../storage.ts";
import { baseUrlForProvider, resolveXaiCredential } from "../search/xai/auth.ts";
import { runXSearch } from "../search/xai/responses.ts";
import { renderSearchResult, toolResultComponent, type ThemeLike } from "../render.ts";

const MISSING_XAI =
  "X search requires xAI. Run `/login grok-build` to use a Grok subscription, or `/login xai` " +
  "if you have xAI API credit. " +
  "glean_search is not a substitute — it does not index X's corpus.";

function sessionIdOf(ctx: ExtensionContext): string | null {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string })?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

export function buildXSearchTool(pi: ExtensionAPI, getConfig: () => ResolvedConfig) {
  const names = getConfig().toolNames;

  return defineTool({
    name: names.xSearch,
    label: "X Search",
    description:
      "Search posts on X (Twitter) directly via xAI's live index. Use this for anything about " +
      `tweets, X posts, or discussion happening on X — ${names.search} does NOT cover X's corpus ` +
      "(general web search indexes X poorly and its results are stale). " +
      "Optional from_date/to_date (YYYY-MM-DD, UTC).",
    promptSnippet: `${names.xSearch}: search X (Twitter) posts directly.`,
    promptGuidelines: [
      `For tweets, X posts, or discussion on X, use ${names.xSearch} — not ${names.search}. ` +
        "General web search does not index X well.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "X (Twitter) search query." }),
      from_date: Type.Optional(
        Type.String({ description: "Only posts on or after this date (YYYY-MM-DD, UTC)." }),
      ),
      to_date: Type.Optional(
        Type.String({ description: "Only posts on or before this date (YYYY-MM-DD, UTC)." }),
      ),
    }),

    renderResult(result, options, theme: ThemeLike) {
      return toolResultComponent(result, options, theme, renderSearchResult);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = getConfig();
      try {
        // Deferred registration removes the "no xAI but tool present" case, but
        // a token can still be revoked mid-session.
        const credential = await resolveXaiCredential(ctx.modelRegistry);
        if (!credential) {
          throw new GleanError("auth", MISSING_XAI, { source: "xai" });
        }

        const result = await runXSearch(
          credential.token,
          {
            query: params.query,
            ...(params.from_date ? { fromDate: params.from_date } : {}),
            ...(params.to_date ? { toDate: params.to_date } : {}),
            ...(config.search.xai.xSearchModel ? { model: config.search.xai.xSearchModel } : {}),
          },
          {
            baseUrl: config.search.xai.baseUrl ?? baseUrlForProvider(credential.providerId),
            ...(signal ? { signal } : {}),
            sessionId: sessionIdOf(ctx),
          },
        );

        const responseId = generateId();
        const data = {
          id: responseId,
          type: "search" as const,
          timestamp: Date.now(),
          queries: [
            {
              query: params.query,
              backend: "xai",
              answer: result.text,
              citations: result.citations,
              error: null,
            },
          ],
        };
        storeResult(responseId, data);
        pi.appendEntry(CUSTOM_TYPE, data);

        const sources = formatSources(result.citations);
        let text = sources ? `${result.text}\n\n${sources}` : result.text;

        // Capped like the other producers. A busy topic on X returns a lot, and
        // the result is stored anyway — without this the agent had no way to
        // page it and no protection from a very large answer.
        const fullLength = text.length;
        const truncated = fullLength > config.fetch.maxInlineChars;
        if (truncated) {
          text =
            `${text.slice(0, config.fetch.maxInlineChars)}\n\n[Truncated]\n` +
            `Use ${names.getContent}({ responseId: "${responseId}", offset: ${config.fetch.maxInlineChars} }) for the rest.`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            responseId,
            backend: "xai",
            corpus: "x",
            citationCount: result.citations.length,
            // One query, stated plainly: the shared search renderer reports
            // "n/m queries", and omitting these rendered it as "0/0 queries".
            queryCount: 1,
            successful: 1,
            truncated,
          },
        };
      } catch (error) {
        const classified = error instanceof GleanError ? error : classifyError(error, "xai");
        return {
          content: [{ type: "text" as const, text: classified.displayMessage }],
          details: { error: classified.message, kind: classified.kind },
          isError: true,
        };
      }
    },
  });
}
