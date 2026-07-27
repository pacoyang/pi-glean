/** Shared test doubles for the search layer. */

import type { ResolvedConfig } from "../../src/config.ts";
import type { ModelRegistryLike, ProviderContext } from "../../src/search/providers.ts";

/** A minimal but complete ResolvedConfig; override just the fields under test. */
export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const base: ResolvedConfig = {
    enabled: true,
    toolNames: {
      search: "glean_search",
      xSearch: "glean_x_search",
      fetch: "glean_fetch",
      getContent: "glean_get_content",
    },
    tools: { search: true, xSearch: true, fetch: true },
    search: {
      backend: "auto",
      providers: ["codex", "xai", "tavily", "perplexity", "exa"],
      batchSize: 5,
      fallbackOn: ["quota", "transient", "network"],
      includeContentLimit: 5,
      codex: { searchContextSize: "medium", freshness: "live" },
      xai: {},
      exa: {},
      tavily: {},
      perplexity: { rateLimit: { maxRequests: 10, windowMs: 60_000 } },
    },
    fetch: {
      timeoutMs: 30_000,
      maxInlineChars: 30_000,
      jina: { enabled: true },
      domainPolicy: { allow: [], deny: [] },
    },
    ssrf: { allowRanges: [], trustEnvProxy: false },
    github: {
      enabled: true,
      maxRepoSizeMB: 350,
      cloneTimeoutSeconds: 30,
      clonePath: "/tmp/glean-repos",
    },
    pdf: { maxPages: 100, writeFile: false, outputDir: "/tmp/glean-pdf" },
    youtube: {
      enabled: true,
      subtitleLangs: ["en"],
      preferAutoSubs: true,
      gemini: { enabled: true },
      ytDlpArgs: [],
    },
    video: { enabled: true, maxSizeMB: 50, preferredModel: "gemini-3-flash-preview" },
    gemini: {},
    shortcuts: { activity: "ctrl+shift+w" },
    sources: {},
  };
  return {
    ...base,
    ...overrides,
    search: { ...base.search, ...overrides.search },
  };
}

export function registryWith(keys: Record<string, string>): ModelRegistryLike {
  return {
    getApiKeyForProvider(provider: string) {
      return keys[provider];
    },
  };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/** Records every request and replays a queue of canned responses. */
export function fakeFetch(
  responder: (request: RecordedRequest) => Response | Promise<Response>,
): FakeFetch {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body !== undefined) {
      body = init.body;
    }
    const record: RecordedRequest = { url, method: init?.method ?? "GET", headers, body };
    requests.push(record);
    return responder(record);
  }) as unknown as typeof fetch;
  return { fetch: impl, requests };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds an SSE body from `[eventName, data]` pairs. */
export function sseResponse(events: Array<[string, unknown]>, status = 200): Response {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

export function providerContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    config: overrides.config ?? testConfig(),
    modelRegistry: overrides.modelRegistry ?? registryWith({}),
    ...overrides,
  };
}
