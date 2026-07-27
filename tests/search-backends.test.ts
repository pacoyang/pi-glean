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
  runXSearch,
  runXaiWebSearch,
} from "../src/search/xai/responses.ts";
import { PROVIDERS } from "../src/search/providers.ts";
import { fakeFetch, jsonResponse, providerContext, testConfig } from "./helpers/fixtures.ts";

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
  function xaiResponse(text: string, citations: string[] = []) {
    return jsonResponse({
      model: "grok",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
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
