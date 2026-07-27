/**
 * The provider table.
 *
 * `synthesized` lives here rather than on each result because it is a static
 * property of the backend, fully determined by which one answered. Putting it
 * on every result would denormalize information `details.backend` already
 * carries, and would have to be remembered at each call site.
 *
 * The `Record<Backend, ProviderDef>` type is what guarantees a new backend
 * cannot be added with a field missing — that is a compile-time property, so
 * there is no runtime test for it.
 */

import type { ResolvedConfig } from "../config.ts";
import { GleanError } from "../errors.ts";
import { hasCredentialSource, resolveCredential } from "../credentials.ts";
import type { RateLimiters } from "../ratelimit.ts";
import { dedupeCitations, type Backend, type SearchAnswer } from "./citations.ts";
import { resolveAccountId } from "./codex/auth.ts";
import { runCodexSearch, type Freshness, type SearchContextSize } from "./codex/responses.ts";
import { resolveCodexModel } from "./codex/models.ts";
import { createTransport } from "./codex/transport.ts";
import { runExaSearch } from "./exa.ts";
import { runPerplexitySearch } from "./perplexity.ts";
import { runTavilySearch } from "./tavily.ts";
import { XAI_CREDENTIAL_PROVIDERS, defaultBaseUrlFor } from "./xai/constants.ts";
import { runXaiWebSearch } from "./xai/responses.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

/**
 * How many results to ask Tavily for.
 *
 * Deliberately not `includeContentLimit`: that governs how many cited pages the
 * background prefetch reads, which is a different question from how wide the
 * search itself should be.
 */
const TAVILY_RESULTS = 5;

/** The slice of pi's ModelRegistry this layer depends on. */
export interface ModelRegistryLike {
  getApiKeyForProvider(provider: string): Promise<string | undefined> | string | undefined;
}

export interface ProviderContext {
  config: ResolvedConfig;
  modelRegistry: ModelRegistryLike;
  sessionId?: string | null;
  signal?: AbortSignal;
  /** Test seam; every backend threads it through. */
  fetchImpl?: typeof fetch;
  rateLimiters?: RateLimiters;
  env?: NodeJS.ProcessEnv;
}

export interface SearchParams {
  query: string;
  freshness?: Freshness;
  searchContextSize?: SearchContextSize;
  allowedDomains?: string[];
  onTextDelta?: (delta: string) => void;
}

export interface ProviderDef {
  /** True when the backend returns a model-written conclusion rather than source text. */
  synthesized: boolean;
  isAvailable(ctx: ProviderContext): Promise<boolean>;
  search(params: SearchParams, ctx: ProviderContext): Promise<SearchAnswer>;
}

/**
 * First xAI credential available, preferring the subscription grant.
 *
 * See XAI_CREDENTIAL_PROVIDERS: the plain `xai` token cannot run the search
 * tools on a subscription-only account, so grok-build is tried first.
 */
export interface XaiCredential {
  token: string;
  /** Which slot it came from — this decides the endpoint. */
  providerId: string;
}

export async function xaiCredential(ctx: ProviderContext): Promise<XaiCredential | undefined> {
  for (const providerId of XAI_CREDENTIAL_PROVIDERS) {
    const token = await apiKeyFor(ctx, providerId);
    if (token) return { token, providerId };
  }
  return undefined;
}

async function apiKeyFor(ctx: ProviderContext, provider: string): Promise<string | undefined> {
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
    return key || undefined;
  } catch {
    return undefined;
  }
}

function credentialOptions(ctx: ProviderContext, provider: "tavily" | "perplexity") {
  const env = ctx.env ?? process.env;
  return {
    provider,
    configuredValue: ctx.config.search[provider].apiKey,
    environmentValue: provider === "tavily" ? env.TAVILY_API_KEY : env.PERPLEXITY_API_KEY,
    ...(ctx.env ? { environment: ctx.env } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

/**
 * Availability asks whether a credential is *configured*, never resolving it.
 *
 * `apiKey: "!op read ..."` runs a subprocess and can prompt for Touch ID.
 * Resolving during the probe would do that on every `/glean-status`, and twice
 * per search on the backend that then runs — once here, once in `search`.
 */
function hasKeyedCredential(ctx: ProviderContext, provider: "tavily" | "perplexity"): boolean {
  return hasCredentialSource(credentialOptions(ctx, provider));
}

async function keyedCredential(
  ctx: ProviderContext,
  provider: "tavily" | "perplexity",
): Promise<string | undefined> {
  const options = credentialOptions(ctx, provider);
  if (!hasCredentialSource(options)) return undefined;
  const value = await resolveCredential(options);
  return value ?? undefined;
}

function answer(
  backend: Backend,
  query: string,
  result: {
    text: string;
    citations: SearchAnswer["citations"];
    searchCalls?: SearchAnswer["searchCalls"];
    raw: unknown;
  },
): SearchAnswer {
  return {
    backend,
    query,
    answer: result.text,
    // Deduped here rather than in each backend: only codex collects into a Map,
    // so tavily, perplexity, xai and exa were all free to repeat a URL — and
    // the position in this list is what the numbered source list calls its rank.
    citations: dedupeCitations(result.citations),
    searchCalls: result.searchCalls ?? [],
    raw: result.raw,
  };
}

export const PROVIDERS: Record<Backend, ProviderDef> = {
  codex: {
    synthesized: true,
    async isAvailable(ctx) {
      return (await apiKeyFor(ctx, OPENAI_CODEX_PROVIDER)) !== undefined;
    },
    async search(params, ctx) {
      const token = await apiKeyFor(ctx, OPENAI_CODEX_PROVIDER);
      if (!token) {
        throw new GleanError("auth", "Codex search requires a ChatGPT subscription.", {
          source: "codex",
          hint: "Run `/login openai-codex` and choose ChatGPT Plus/Pro.",
        });
      }
      const accountId = resolveAccountId(token, ctx.modelRegistry);
      if (!accountId) {
        throw new GleanError("auth", "Could not determine the ChatGPT account id.", {
          source: "codex",
          hint: "Run `/login openai-codex` again to refresh the stored credential.",
        });
      }

      const codexConfig = ctx.config.search.codex;
      const modelOptions: Parameters<typeof resolveCodexModel>[0] = { token, accountId };
      if (codexConfig.baseUrl !== undefined) modelOptions.baseUrl = codexConfig.baseUrl;
      if (codexConfig.clientVersion !== undefined)
        modelOptions.clientVersion = codexConfig.clientVersion;
      if (codexConfig.model !== undefined) modelOptions.configuredModel = codexConfig.model;
      if (ctx.fetchImpl !== undefined) modelOptions.fetchImpl = ctx.fetchImpl;
      if (ctx.signal !== undefined) modelOptions.signal = ctx.signal;
      const model = await resolveCodexModel(modelOptions);

      const transportOptions: Parameters<typeof createTransport>[0] = { token, accountId };
      if (codexConfig.baseUrl !== undefined) transportOptions.baseUrl = codexConfig.baseUrl;
      if (codexConfig.clientVersion !== undefined)
        transportOptions.clientVersion = codexConfig.clientVersion;
      if (ctx.fetchImpl !== undefined) transportOptions.fetchImpl = ctx.fetchImpl;

      const searchOptions: Parameters<typeof runCodexSearch>[0] = {
        query: params.query,
        model,
        transport: createTransport(transportOptions),
        freshness: params.freshness ?? codexConfig.freshness,
        searchContextSize: params.searchContextSize ?? codexConfig.searchContextSize,
      };
      if (ctx.sessionId) searchOptions.sessionId = ctx.sessionId;
      if (ctx.signal !== undefined) searchOptions.signal = ctx.signal;
      if (params.onTextDelta !== undefined) searchOptions.onTextDelta = params.onTextDelta;

      const result = await runCodexSearch(searchOptions);
      return answer("codex", params.query, {
        text: result.text,
        citations: result.citations,
        searchCalls: result.searchCalls,
        raw: result,
      });
    },
  },

  xai: {
    synthesized: true,
    async isAvailable(ctx) {
      return (await xaiCredential(ctx)) !== undefined;
    },
    async search(params, ctx) {
      const credential = await xaiCredential(ctx);
      if (!credential) {
        throw new GleanError("auth", "xAI search requires an xAI credential.", {
          source: "xai",
          hint:
            "Run `/login grok-build` to use a Grok " +
            "subscription. `/login xai` alone only reaches the API-billed path, which needs " +
            "xAI API credit.",
        });
      }
      const xaiConfig = ctx.config.search.xai;
      const result = await runXaiWebSearch(
        credential.token,
        {
          query: params.query,
          ...(params.allowedDomains ? { allowedDomains: params.allowedDomains } : {}),
          ...(xaiConfig.webSearchModel ? { model: xaiConfig.webSearchModel } : {}),
        },
        {
          baseUrl: xaiConfig.baseUrl ?? defaultBaseUrlFor(credential.providerId),
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          sessionId: ctx.sessionId ?? null,
        },
      );
      return answer("xai", params.query, result);
    },
  },

  tavily: {
    synthesized: true,
    isAvailable(ctx) {
      return Promise.resolve(hasKeyedCredential(ctx, "tavily"));
    },
    async search(params, ctx) {
      const apiKey = await keyedCredential(ctx, "tavily");
      if (!apiKey) {
        throw new GleanError("credential", "Tavily search requires an API key.", {
          source: "tavily",
          hint: "Set TAVILY_API_KEY or search.tavily.apiKey in pi-glean.json.",
        });
      }
      const result = await runTavilySearch(apiKey, params.query, {
        numResults: TAVILY_RESULTS,
        ...(params.allowedDomains ? { allowedDomains: params.allowedDomains } : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return answer("tavily", params.query, result);
    },
  },

  perplexity: {
    synthesized: true,
    isAvailable(ctx) {
      return Promise.resolve(hasKeyedCredential(ctx, "perplexity"));
    },
    async search(params, ctx) {
      const apiKey = await keyedCredential(ctx, "perplexity");
      if (!apiKey) {
        throw new GleanError("credential", "Perplexity search requires an API key.", {
          source: "perplexity",
          hint: "Set PERPLEXITY_API_KEY or search.perplexity.apiKey in pi-glean.json.",
        });
      }
      const result = await runPerplexitySearch(apiKey, params.query, {
        ...(ctx.config.search.perplexity.model
          ? { model: ctx.config.search.perplexity.model }
          : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.rateLimiters?.perplexity ? { rateLimiter: ctx.rateLimiters.perplexity } : {}),
      });
      return answer("perplexity", params.query, result);
    },
  },

  exa: {
    // Returns page text, not a conclusion — complete information, just unsummarized.
    synthesized: false,
    // No credential exists to check: this is the floor that always works.
    async isAvailable() {
      return true;
    },
    async search(params, ctx) {
      const result = await runExaSearch(params.query, {
        ...(ctx.config.search.exa.mcpUrl ? { mcpUrl: ctx.config.search.exa.mcpUrl } : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return answer("exa", params.query, result);
    },
  },
};
