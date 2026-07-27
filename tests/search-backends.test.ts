import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { EXA_MCP_URL, parseExaBlocks, runExaSearch } from "../src/search/exa.ts";
import { runTavilySearch, splitDomainFilter } from "../src/search/tavily.ts";
import { runPerplexitySearch } from "../src/search/perplexity.ts";
import {
  citationsFrom,
  clampPromptCacheKey,
  glueCitationSpacing,
  expandToSentence,
  isGrokCliProxyBaseUrl,
  runXSearch,
  xaiRequestHeaders,
  runXaiWebSearch,
} from "../src/search/xai/responses.ts";
import { PROVIDERS } from "../src/search/providers.ts";
import {
  fakeFetch,
  jsonResponse,
  providerContext,
  registryWith,
  testConfig,
} from "./helpers/fixtures.ts";

describe("exa", () => {
  const EXA_TEXT = [
    "Title: useOptimistic – React",
    "URL: https://react.dev/reference/react/useOptimistic",
    "useOptimistic is a React Hook that lets you optimistically update the UI.",
    "",
    "Title: React 19",
    "URL: https://react.dev/blog/react-19",
    "React 19 is now stable.",
  ].join("\n");

  function mcpResponse(text: string) {
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
  }

  it("sends an unauthenticated JSON-RPC tools/call", async () => {
    const fake = fakeFetch(() => mcpResponse(EXA_TEXT));
    await runExaSearch("react 19", { fetchImpl: fake.fetch });

    const request = fake.requests[0]!;
    assert.equal(request.url, EXA_MCP_URL);
    assert.equal(request.method, "POST");
    const body = request.body as Record<string, unknown>;
    assert.equal(body.method, "tools/call");
    assert.equal((body.params as Record<string, unknown>).name, "web_search_exa");

    // The whole point of this backend is that it needs no credential.
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-api-key"], undefined);
  });

  it("accepts an SSE-framed reply as well as a plain JSON body", async () => {
    const payload = JSON.stringify({ result: { content: [{ type: "text", text: EXA_TEXT }] } });
    const fake = fakeFetch(
      () =>
        new Response(`event: message\ndata: ${payload}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await runExaSearch("q", { fetchImpl: fake.fetch });
    assert.match(result.text, /useOptimistic/);
  });

  it("parses Title/URL blocks into citations", () => {
    const citations = parseExaBlocks(EXA_TEXT);
    assert.equal(citations.length, 2);
    assert.equal(citations[0]?.url, "https://react.dev/reference/react/useOptimistic");
    assert.equal(citations[0]?.title, "useOptimistic – React");
  });

  it("returns page text verbatim rather than a summary", async () => {
    const fake = fakeFetch(() => mcpResponse(EXA_TEXT));
    const result = await runExaSearch("q", { fetchImpl: fake.fetch });
    assert.equal(result.text, EXA_TEXT);
  });

  it("classifies an RPC-level error", async () => {
    const fake = fakeFetch(() => jsonResponse({ error: { code: -32000, message: "boom" } }));
    await assert.rejects(
      () => runExaSearch("q", { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "invalid-response");
        assert.match(error.message, /-32000: boom/);
        return true;
      },
    );
  });

  it("rejects an unparseable body", async () => {
    const fake = fakeFetch(() => new Response("not json at all"));
    await assert.rejects(() => runExaSearch("q", { fetchImpl: fake.fetch }), /empty response/);
  });

  it("classifies an HTTP failure", async () => {
    const fake = fakeFetch(() => new Response("slow down", { status: 429 }));
    await assert.rejects(
      () => runExaSearch("q", { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "quota");
        return true;
      },
    );
  });
});

describe("tavily", () => {
  it("asks for a server-side synthesized answer", async () => {
    const fake = fakeFetch(() => jsonResponse({ answer: "an answer", results: [] }));
    await runTavilySearch("key-1", "q", { fetchImpl: fake.fetch });
    const body = fake.requests[0]!.body as Record<string, unknown>;
    assert.equal(body.include_answer, "basic");
    assert.equal(fake.requests[0]!.headers.authorization, "Bearer key-1");
  });

  it("splits the domain filter on the leading minus", () => {
    assert.deepEqual(splitDomainFilter(["react.dev", "-x.com"]), {
      include_domains: ["react.dev"],
      exclude_domains: ["x.com"],
    });
    assert.deepEqual(splitDomainFilter(undefined), {});
  });

  it("maps results to citations", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        answer: "text",
        results: [{ title: "React", url: "https://react.dev" }, { title: "no url" }],
      }),
    );
    const result = await runTavilySearch("k", "q", { fetchImpl: fake.fetch });
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.title, "React");
  });

  it("keeps the API key out of error messages", async () => {
    const fake = fakeFetch(() => new Response("bad key sk-secret-123 rejected", { status: 401 }));
    await assert.rejects(
      () => runTavilySearch("sk-secret-123", "q", { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.doesNotMatch(error.message, /sk-secret-123/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  });
});

describe("perplexity", () => {
  it("extracts the assistant message and citations", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "synthesized answer" } }],
        search_results: [{ title: "React", url: "https://react.dev" }],
        citations: ["https://react.dev", "https://example.com"],
      }),
    );
    const result = await runPerplexitySearch("key", "q", { fetchImpl: fake.fetch });
    assert.equal(result.text, "synthesized answer");
    assert.deepEqual(
      result.citations.map((c) => c.url),
      ["https://react.dev", "https://example.com"],
      "titled results first, bare citations deduped after",
    );
  });

  it("waits on the rate limiter before spending a request", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const fake = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await runPerplexitySearch("k", "one", { fetchImpl: fake.fetch, rateLimiter: limiter });
    await runPerplexitySearch("k", "two", { fetchImpl: fake.fetch, rateLimiter: limiter });

    assert.deepEqual(sleeps, [1000], "second call waits rather than failing");
    assert.equal(fake.requests.length, 2);
  });

  it("keeps the API key out of error messages", async () => {
    const fake = fakeFetch(() => new Response("token pplx-secret invalid", { status: 403 }));
    await assert.rejects(
      () => runPerplexitySearch("pplx-secret", "q", { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.doesNotMatch(error.message, /pplx-secret/);
        return true;
      },
    );
  });
});

describe("xai", () => {
  /**
   * A well-formed reply. The search call matters: a response carrying neither a
   * call nor a citation is rejected as never having searched, so a fixture
   * without one would fail for reasons unrelated to what it is testing.
   */
  function xaiResponse(text: string, citations: string[] = []) {
    return jsonResponse({
      model: "grok",
      output: [
        { type: "web_search_call", action: { type: "search", query: "q" }, status: "completed" },
        { type: "message", content: [{ type: "output_text", text }] },
      ],
      citations,
    });
  }

  it("passes allowed_domains through as a filter", async () => {
    const fake = fakeFetch(() => xaiResponse("answer"));
    await runXaiWebSearch(
      "key",
      { query: "q", allowedDomains: ["react.dev"] },
      { fetchImpl: fake.fetch },
    );
    const tool = (
      (fake.requests[0]!.body as Record<string, unknown>).tools as Record<string, unknown>[]
    )[0]!;
    assert.equal(tool.type, "web_search");
    assert.deepEqual(tool.filters, { allowed_domains: ["react.dev"] });
  });

  it("uses the x_search tool with date bounds for X search", async () => {
    const fake = fakeFetch(() => xaiResponse("tweets"));
    await runXSearch(
      "key",
      { query: "q", fromDate: "2026-01-01", toDate: "2026-02-01" },
      { fetchImpl: fake.fetch, sessionId: "sess" },
    );
    const body = fake.requests[0]!.body as Record<string, unknown>;
    const tool = (body.tools as Record<string, unknown>[])[0]!;
    assert.equal(tool.type, "x_search", "x_search is a different corpus, not a different vendor");
    assert.equal(tool.from_date, "2026-01-01");
    assert.equal(tool.to_date, "2026-02-01");
    assert.equal(body.prompt_cache_key, "sess");
  });

  it("does not send session affinity for general web search", async () => {
    const fake = fakeFetch(() => xaiResponse("answer"));
    await runXaiWebSearch("key", { query: "q" }, { fetchImpl: fake.fetch, sessionId: "sess" });
    assert.equal((fake.requests[0]!.body as Record<string, unknown>).prompt_cache_key, undefined);
  });

  it("clamps the prompt cache key to 64 characters", () => {
    assert.equal(clampPromptCacheKey("short"), "short");
    assert.equal(clampPromptCacheKey("x".repeat(100))?.length, 64);
    assert.equal(clampPromptCacheKey("   "), undefined);
    assert.equal(clampPromptCacheKey(null), undefined);
  });

  it("inserts the space Grok omits before an inline citation marker", () => {
    assert.equal(
      glueCitationSpacing("see https://react.dev[[1]](https://react.dev)"),
      "see https://react.dev [[1]](https://react.dev)",
    );
  });

  it("recovers the supporting sentence for a bare citation URL", () => {
    const text = "First sentence. React 19 is stable per https://react.dev/blog. Third one.";
    const citations = citationsFrom({ citations: ["https://react.dev/blog"] }, text);
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.title, "react.dev");
    const slice = text.slice(citations[0]!.startIndex!, citations[0]!.endIndex!);
    assert.match(slice, /React 19 is stable/);
  });

  it("truncates a long error body", async () => {
    const fake = fakeFetch(() => new Response("e".repeat(2000), { status: 500 }));
    await assert.rejects(
      () => runXaiWebSearch("key", { query: "q" }, { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.ok(error.message.length < 700, `message was ${error.message.length} chars`);
        return true;
      },
    );
  });

  it("rejects an empty query before making a request", async () => {
    const fake = fakeFetch(() => xaiResponse("x"));
    await assert.rejects(
      () => runXaiWebSearch("key", { query: "   " }, { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "schema");
        return true;
      },
    );
    assert.equal(fake.requests.length, 0);
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await assert.rejects(
      () =>
        runXaiWebSearch(
          "key",
          { query: "q" },
          { fetchImpl: fake.fetch, signal: controller.signal },
        ),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "aborted");
        assert.match(error.message, /cancelled/);
        return true;
      },
    );
  });
});

describe("credential probing", () => {
  /** A credential source whose execution leaves a file behind. */
  function tracer(marker: string) {
    const path = join(tmpdir(), `glean-cred-probe-${marker}`);
    rmSync(path, { force: true });
    const config = testConfig();
    config.search = {
      ...config.search,
      tavily: { apiKey: `!touch ${path} && echo secret` },
      perplexity: { ...config.search.perplexity, apiKey: `!touch ${path} && echo secret` },
    };
    return {
      path,
      ran: () => existsSync(path),
      ctx: providerContext({ config, env: {} as NodeJS.ProcessEnv }),
    };
  }

  it("does not execute a credential helper just to report availability", async () => {
    // `apiKey: "!op read ..."` spawns a process and can prompt for Touch ID.
    // /glean-status probes every backend, and routing probes each one before
    // trying it — neither is a reason to unlock a password manager.
    const probe = tracer("availability");
    try {
      assert.equal(await PROVIDERS.tavily.isAvailable(probe.ctx), true);
      assert.equal(await PROVIDERS.perplexity.isAvailable(probe.ctx), true);
      assert.equal(probe.ran(), false, "the credential command was executed during a probe");
    } finally {
      rmSync(probe.path, { force: true });
    }
  });

  it("does execute it when a search actually runs", async () => {
    // The counterpart assertion: the probe must be the only thing that skips
    // resolution, or the test above would pass on a broken resolver.
    const probe = tracer("resolve");
    try {
      const { resolveCredential } = await import("../src/credentials.ts");
      await resolveCredential({
        provider: "tavily",
        configuredValue: probe.ctx.config.search.tavily.apiKey,
      });
      assert.equal(probe.ran(), true);
    } finally {
      rmSync(probe.path, { force: true });
    }
  });

  it("reports unavailable when nothing is configured", async () => {
    const ctx = providerContext({ config: testConfig(), env: {} as NodeJS.ProcessEnv });
    assert.equal(await PROVIDERS.tavily.isAvailable(ctx), false);
    assert.equal(await PROVIDERS.perplexity.isAvailable(ctx), false);
  });

  it("treats exa as always available, with no credential to check", async () => {
    const ctx = providerContext({ config: testConfig(), env: {} as NodeJS.ProcessEnv });
    assert.equal(await PROVIDERS.exa.isAvailable(ctx), true);
  });
});

describe("citation normalization", () => {
  it("dedupes and drops uncitable URLs whichever backend answered", async () => {
    // Only codex collected into a Map; every other backend pushed straight into
    // an array, so a repeated URL showed up twice in the numbered source list
    // and shifted the rank of everything after it.
    const fake = fakeFetch(() =>
      jsonResponse({
        answer: "text",
        results: [
          { title: "React", url: "https://react.dev" },
          { title: "React again", url: "https://react.dev" },
          { title: "Other", url: "https://other.test" },
          { title: "Relative", url: "/not-citable" },
        ],
      }),
    );
    const ctx = providerContext({
      config: testConfig(),
      env: { TAVILY_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: fake.fetch,
    });

    const result = await PROVIDERS.tavily.search({ query: "q" }, ctx);
    assert.deepEqual(
      result.citations.map((citation) => citation.url),
      ["https://react.dev/", "https://other.test/"],
    );
    // First seen wins, because that position is the rank.
    assert.equal(result.citations[0]?.title, "React");
  });
});

describe("grok cli proxy", () => {
  it("recognises the proxy host only", () => {
    assert.equal(isGrokCliProxyBaseUrl("https://cli-chat-proxy.grok.com/v1"), true);
    assert.equal(isGrokCliProxyBaseUrl("https://api.x.ai/v1"), false);
    assert.equal(isGrokCliProxyBaseUrl(undefined), false);
    // Not a substring match on the whole URL: a path must not qualify a host.
    assert.equal(isGrokCliProxyBaseUrl("https://evil.test/cli-chat-proxy.grok.com"), false);
  });

  it("sends the CLI identity to the proxy and nothing extra to the API", () => {
    // Without these the proxy accepts the connection and never answers —
    // observed as a five minute hang, reported as a timeout rather than as
    // anything diagnosable.
    assert.deepEqual(
      Object.keys(xaiRequestHeaders("grok-4.20-multi-agent", "https://api.x.ai/v1", "s")),
      ["User-Agent"],
    );

    const proxy = xaiRequestHeaders("grok-4.5", "https://cli-chat-proxy.grok.com/v1", "sess-1");
    assert.equal(proxy["x-grok-client-identifier"], "grok-shell");
    assert.equal(proxy["x-xai-token-auth"], "xai-grok-cli");
    assert.equal(proxy["x-grok-model-override"], "grok-4.5");
    assert.equal(proxy["x-grok-conv-id"], "sess-1");

    // No session means no conversation id, rather than an empty one.
    assert.equal(
      xaiRequestHeaders("m", "https://cli-chat-proxy.grok.com/v1")["x-grok-conv-id"],
      undefined,
    );
  });

  it("puts them on the actual request", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
          { type: "message", content: [{ type: "output_text", text: "a" }] },
        ],
        usage: { num_server_side_tools_used: 1 },
      }),
    );
    await runXaiWebSearch(
      "token",
      { query: "q" },
      { baseUrl: "https://cli-chat-proxy.grok.com/v1", fetchImpl: fake.fetch, sessionId: "s" },
    );
    assert.equal(fake.requests[0]?.headers["x-grok-client-identifier"], "grok-shell");
    assert.equal(fake.requests[0]?.headers.authorization, "Bearer token");
  });
});

describe("refusing an unsearched answer", () => {
  /** What cli-chat-proxy.grok.com returns: a fluent reply, no search, no sources. */
  const UNSEARCHED = {
    output: [
      { type: "reasoning", content: [] },
      {
        type: "message",
        content: [{ type: "output_text", text: "I'll look up the latest yt-dlp release." }],
      },
    ],
  };

  it("rejects a reply with no search call and no citation", async () => {
    // The endpoint accepted a web_search tool and ignored it. Returning this as
    // a search result gives the agent an unsourced answer from the model's own
    // memory, presented as though it had been looked up.
    const fake = fakeFetch(() => jsonResponse(UNSEARCHED));
    await assert.rejects(
      () => runXaiWebSearch("token", { query: "latest yt-dlp release" }, { fetchImpl: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "invalid-response");
        assert.match(error.message, /without performing a search/);
        // The endpoint is named so the message says which host misbehaved.
        assert.match(error.hint ?? "", /api\.x\.ai/);
        return true;
      },
    );
  });

  it("applies to x_search too", async () => {
    const fake = fakeFetch(() => jsonResponse(UNSEARCHED));
    await assert.rejects(
      () => runXSearch("token", { query: "pi coding agent" }, { fetchImpl: fake.fetch }),
      /without performing a search/,
    );
  });

  it("accepts a real search that happens to cite nothing", async () => {
    // A recorded call is proof enough; some queries genuinely return no source.
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", action: { type: "search", query: "q" }, status: "completed" },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      }),
    );
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.equal(result.text, "An answer.");
    assert.equal(result.searchCalls.length, 1);
  });
});

describe("trusting xAI's own tool-use count", () => {
  it("rejects a reply xAI reports as having used no server-side tool", async () => {
    // The verbatim shape cli-chat-proxy.grok.com returns: our web_search tool
    // echoed back as an empty array, and the count saying so outright.
    const fake = fakeFetch(() =>
      jsonResponse({
        model: "grok-4.5",
        tools: [],
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            content: [{ type: "output_text", text: "I'll look that up.", annotations: [] }],
          },
        ],
        usage: { num_sources_used: 0, num_server_side_tools_used: 0 },
      }),
    );
    await assert.rejects(
      () => runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch }),
      /without performing a search/,
    );
  });

  it("accepts a reply the count vouches for, even with nothing parsed out", async () => {
    // The count is the authority when present: trusting our own parsing here
    // would reject a genuine search whose result shape we do not recognise.
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "An answer." }] }],
        usage: { num_server_side_tools_used: 2 },
      }),
    );
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.equal(result.text, "An answer.");
  });

  it("falls back to the parsed signals when the count is absent", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", action: { type: "search", query: "q" }, status: "completed" },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      }),
    );
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.equal(result.searchCalls.length, 1);
  });
});

describe("xai citation annotations", () => {
  // Live offsets span exactly the inline marker — verified against a real
  // response where start..end was 50..105 for a 55-character marker.
  const SENTENCE = "The answer is 2026-07-04. It is confirmed on the releases page.";
  const MARKER = "[[1]](https://github.com/yt-dlp/yt-dlp/releases)";
  const TEXT = SENTENCE + MARKER;

  function annotated(text = TEXT, markerAt = SENTENCE.length, markerLen = MARKER.length) {
    return {
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text,
              annotations: [
                {
                  type: "url_citation",
                  url: "https://github.com/yt-dlp/yt-dlp/releases",
                  start_index: markerAt,
                  end_index: markerAt + markerLen,
                  title: "1",
                },
              ],
            },
          ],
        },
      ],
      usage: { num_server_side_tools_used: 3 },
    };
  }

  it("reads url_citation annotations, which the top-level array no longer carries", async () => {
    // Live responses have no `citations` array at all — sources arrive only as
    // annotations, so reading just the array reported zero sources for every
    // successful search.
    const fake = fakeFetch(() => jsonResponse(annotated()));
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });

    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.url, "https://github.com/yt-dlp/yt-dlp/releases");
    // A numeric title is the inline marker, not a name.
    assert.equal(result.citations[0]?.title, "github.com");
  });

  it("attributes the sentence, not the citation marker", async () => {
    // Codex's offsets point at the prose; xAI's point at the `[[1]](url)`
    // marker. Citation.startIndex means the same thing either way or it is
    // useless, so the marker span is widened to the sentence it follows.
    const fake = fakeFetch(() => jsonResponse(annotated()));
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });

    const { startIndex, endIndex } = result.citations[0]!;
    const attributed = result.text.slice(startIndex, endIndex);
    assert.match(attributed, /It is confirmed on the releases page\./);
    assert.doesNotMatch(attributed, /The answer is/, "only the sentence it annotates");
  });

  it("recovers sources from inline markers when nothing else carries them", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Answer.[[1]](https://a.test/x) More.[[2]](https://b.test/y)",
              },
            ],
          },
        ],
        usage: { num_server_side_tools_used: 2 },
      }),
    );
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.deepEqual(
      result.citations.map((c) => c.url),
      ["https://a.test/x", "https://b.test/y"],
    );
  });

  it("still reads the legacy top-level array", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
          { type: "message", content: [{ type: "output_text", text: "Answer." }] },
        ],
        citations: ["https://legacy.test/a"],
      }),
    );
    const result = await runXaiWebSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.equal(result.citations[0]?.url, "https://legacy.test/a");
  });

  it("leaves a prose span untouched", () => {
    // A Codex-style span already *is* the attributed text. Position alone
    // cannot tell it from a marker — both follow a sentence end — so widening
    // by position would swallow the sentence before every Codex citation.
    const text = "First sentence. Second sentence here. Third.";
    assert.deepEqual(expandToSentence(text, 16, 36), [16, 36]);
    // Out-of-range input is returned untouched rather than silently clamped.
    assert.deepEqual(expandToSentence(text, 5, 999), [5, 999]);
  });
});

describe("x_search tool calls", () => {
  it("counts custom_tool_call fan-out, which is how x_search reports", async () => {
    // Live x_search never emits `x_search_call`: the model calls
    // x_semantic_search and x_keyword_search as custom tools, so matching only
    // the documented type reported zero searches for every X query.
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          {
            type: "custom_tool_call",
            name: "x_semantic_search",
            input: '{"query":"pi coding agent","limit":"10"}',
            status: "completed",
          },
          {
            type: "custom_tool_call",
            name: "x_keyword_search",
            input: '{"query":"\\"pi coding agent\\" since:2026-01-01"}',
            status: "completed",
          },
          // Not a search; must not be counted as one.
          { type: "custom_tool_call", name: "code_interpreter", input: "{}", status: "completed" },
          { type: "message", content: [{ type: "output_text", text: "Posts found." }] },
        ],
        usage: { num_server_side_tools_used: 2 },
      }),
    );
    const result = await runXSearch(
      "token",
      { query: "pi coding agent" },
      { fetchImpl: fake.fetch },
    );

    assert.equal(result.searchCalls.length, 2);
    assert.equal(result.searchCalls[0]?.query, "pi coding agent");
    assert.equal(result.searchCalls[0]?.status, "completed");
  });

  it("still counts a call whose arguments cannot be parsed", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          {
            type: "custom_tool_call",
            name: "x_keyword_search",
            input: "not json",
            status: "completed",
          },
          { type: "message", content: [{ type: "output_text", text: "Posts." }] },
        ],
        usage: { num_server_side_tools_used: 1 },
      }),
    );
    const result = await runXSearch("token", { query: "q" }, { fetchImpl: fake.fetch });
    assert.equal(result.searchCalls.length, 1);
    assert.equal(result.searchCalls[0]?.query, undefined);
  });
});

describe("endpoint follows the credential", () => {
  function ctxWith(keys: Record<string, string>, baseUrl?: string) {
    const config = testConfig();
    if (baseUrl) config.search = { ...config.search, xai: { baseUrl } };
    return { config, modelRegistry: registryWith(keys) };
  }

  async function hostFor(keys: Record<string, string>, baseUrl?: string) {
    const fake = fakeFetch(() =>
      jsonResponse({
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
          { type: "message", content: [{ type: "output_text", text: "a" }] },
        ],
        usage: { num_server_side_tools_used: 1 },
      }),
    );
    const ctx = providerContext({ ...ctxWith(keys, baseUrl), fetchImpl: fake.fetch });
    await PROVIDERS.xai.search({ query: "q" }, ctx);
    return new URL(fake.requests[0]!.url).hostname;
  }

  it("sends a subscription credential to the proxy", async () => {
    // A Grok subscription is provisioned for the CLI proxy.
    assert.equal(await hostFor({ "grok-build": "sub-token" }), "cli-chat-proxy.grok.com");
  });

  it("sends an API credential to the public API", async () => {
    // An XAI_API_KEY is an api.x.ai credential; the proxy does not know it.
    // Routing it to the subscription host would fail for reasons the user
    // could not act on.
    assert.equal(await hostFor({ xai: "api-key" }), "api.x.ai");
  });

  it("prefers the subscription when both exist", async () => {
    assert.equal(
      await hostFor({ "grok-build": "sub-token", xai: "api-key" }),
      "cli-chat-proxy.grok.com",
    );
  });

  it("lets an explicit baseUrl win either way", async () => {
    assert.equal(await hostFor({ "grok-build": "t" }, "https://api.x.ai/v1"), "api.x.ai");
    assert.equal(
      await hostFor({ xai: "t" }, "https://cli-chat-proxy.grok.com/v1"),
      "cli-chat-proxy.grok.com",
    );
  });
});
