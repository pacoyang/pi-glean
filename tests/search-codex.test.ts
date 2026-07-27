import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import { runCodexSearch, webAccessForFreshness } from "../src/search/codex/responses.ts";
import {
  createTransport,
  normalizeBaseUrl,
  resolveEndpoint,
} from "../src/search/codex/transport.ts";
import { extractAccountIdFromToken, resolveAccountId } from "../src/search/codex/auth.ts";
import { fakeFetch, sseResponse } from "./helpers/fixtures.ts";

function transportWith(fetchImpl: typeof fetch) {
  return createTransport({ token: "tok", accountId: "acct-1", fetchImpl });
}

const COMPLETED_MESSAGE = {
  item: {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "React 19 removed forwardRef.",
        annotations: [
          {
            type: "url_citation",
            title: "React 19",
            url: "https://react.dev/blog/react-19",
            start_index: 0,
            end_index: 27,
          },
        ],
      },
    ],
  },
};

describe("request shape", () => {
  it("sends the codex impersonation headers", async () => {
    const fake = fakeFetch(() => sseResponse([["response.completed", { response: {} }]]));
    await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
    });

    const headers = fake.requests[0]!.headers;
    assert.equal(headers.authorization, "Bearer tok");
    assert.equal(headers["chatgpt-account-id"], "acct-1");
    assert.equal(headers.originator, "codex_cli_rs");
    assert.match(headers["user-agent"] ?? "", /^codex_cli_rs\/[\d.]+ \(.+\) /);
  });

  it("requires the web_search tool so the model cannot answer from memory", async () => {
    const fake = fakeFetch(() => sseResponse([["response.completed", { response: {} }]]));
    await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "high",
    });

    const body = fake.requests[0]!.body as Record<string, unknown>;
    assert.equal(body.tool_choice, "required");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    const tool = (body.tools as Record<string, unknown>[])[0]!;
    assert.equal(tool.type, "web_search");
    assert.equal(tool.search_context_size, "high");
  });

  it("passes the session id through for request affinity", async () => {
    const fake = fakeFetch(() => sseResponse([["response.completed", { response: {} }]]));
    await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
      sessionId: "sess-9",
    });
    assert.equal(fake.requests[0]!.headers["session-id"], "sess-9");
  });
});

describe("freshness", () => {
  it("maps each level onto the web-access flags", () => {
    assert.deepEqual(webAccessForFreshness("cached"), { external: false });
    assert.deepEqual(webAccessForFreshness("indexed"), { external: false, indexed: true });
    assert.deepEqual(webAccessForFreshness("live"), { external: true });
  });

  it("only sets indexed_web_access for the indexed level", async () => {
    for (const [freshness, expected] of [
      ["cached", undefined],
      ["indexed", true],
      ["live", undefined],
    ] as const) {
      const fake = fakeFetch(() => sseResponse([["response.completed", { response: {} }]]));
      await runCodexSearch({
        query: "q",
        model: "gpt-5",
        transport: transportWith(fake.fetch),
        freshness,
        searchContextSize: "medium",
      });
      const tool = (
        (fake.requests[0]!.body as Record<string, unknown>).tools as Record<string, unknown>[]
      )[0]!;
      assert.equal(tool.indexed_web_access, expected, `freshness=${freshness}`);
    }
  });
});

describe("SSE parsing", () => {
  it("collects citations with their character offsets", async () => {
    const fake = fakeFetch(() =>
      sseResponse([
        ["response.created", { response: { id: "resp-1" } }],
        ["response.output_item.done", COMPLETED_MESSAGE],
        ["response.completed", { response: { usage: { input_tokens: 10, output_tokens: 20 } } }],
      ]),
    );
    const result = await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
    });

    assert.equal(result.responseId, "resp-1");
    assert.equal(result.text, "React 19 removed forwardRef.");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.url, "https://react.dev/blog/react-19");
    assert.equal(result.citations[0]?.startIndex, 0);
    assert.equal(result.citations[0]?.endIndex, 27);
    assert.equal(result.usage?.inputTokens, 10);
  });

  it("streams deltas and prefers the completed message text", async () => {
    const deltas: string[] = [];
    const fake = fakeFetch(() =>
      sseResponse([
        ["response.output_text.delta", { delta: "React " }],
        ["response.output_text.delta", { delta: "19…" }],
        ["response.output_item.done", COMPLETED_MESSAGE],
      ]),
    );
    const result = await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
      onTextDelta: (delta) => deltas.push(delta),
    });

    assert.deepEqual(deltas, ["React ", "19…"]);
    assert.equal(result.text, "React 19 removed forwardRef.", "final message wins over deltas");
  });

  it("falls back to streamed text when no message item arrives", async () => {
    const fake = fakeFetch(() =>
      sseResponse([
        ["response.output_text.delta", { delta: "partial answer" }],
        ["response.completed", { response: {} }],
      ]),
    );
    const result = await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
    });
    assert.equal(result.text, "partial answer");
  });

  it("records web_search_call items", async () => {
    const fake = fakeFetch(() =>
      sseResponse([
        [
          "response.output_item.added",
          { item: { type: "web_search_call", id: "ws-1", status: "in_progress" } },
        ],
        [
          "response.output_item.done",
          {
            item: {
              type: "web_search_call",
              id: "ws-1",
              status: "completed",
              action: { query: "react 19" },
            },
          },
        ],
      ]),
    );
    const result = await runCodexSearch({
      query: "q",
      model: "gpt-5",
      transport: transportWith(fake.fetch),
      freshness: "live",
      searchContextSize: "medium",
    });
    assert.equal(result.searchCalls.length, 1);
    assert.equal(result.searchCalls[0]?.query, "react 19");
    assert.equal(result.searchCalls[0]?.status, "completed");
  });

  it("ignores the [DONE] sentinel", async () => {
    const fake = fakeFetch(
      () =>
        new Response("event: response.completed\ndata: {}\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await assert.doesNotReject(() =>
      runCodexSearch({
        query: "q",
        model: "gpt-5",
        transport: transportWith(fake.fetch),
        freshness: "live",
        searchContextSize: "medium",
      }),
    );
  });

  it("throws when the stream reports a failure", async () => {
    const fake = fakeFetch(() =>
      sseResponse([["response.failed", { error: { message: "rate limit exceeded" } }]]),
    );
    await assert.rejects(
      () =>
        runCodexSearch({
          query: "q",
          model: "gpt-5",
          transport: transportWith(fake.fetch),
          freshness: "live",
          searchContextSize: "medium",
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "quota");
        return true;
      },
    );
  });
});

describe("HTTP errors", () => {
  it("classifies 401 as auth and 429 as quota", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [429, "quota"],
      [503, "transient"],
    ] as const) {
      const fake = fakeFetch(() => new Response("nope", { status }));
      await assert.rejects(
        () =>
          runCodexSearch({
            query: "q",
            model: "gpt-5",
            transport: transportWith(fake.fetch),
            freshness: "live",
            searchContextSize: "medium",
          }),
        (error: unknown) => {
          assert.ok(error instanceof GleanError);
          assert.equal(error.kind, kind, `status ${status}`);
          assert.equal(error.status, status);
          return true;
        },
      );
    }
  });

  it("replaces a Cloudflare interstitial with advice instead of HTML", async () => {
    const fake = fakeFetch(
      () => new Response("<html>/cdn-cgi/challenge-platform/x</html>", { status: 403 }),
    );
    await assert.rejects(
      () =>
        runCodexSearch({
          query: "q",
          model: "gpt-5",
          transport: transportWith(fake.fetch),
          freshness: "live",
          searchContextSize: "medium",
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.match(error.message, /Cloudflare challenge blocked the request/);
        assert.doesNotMatch(error.message, /<html>/);
        return true;
      },
    );
  });
});

describe("endpoint resolution", () => {
  it("tolerates a base URL pasted with its path suffix", () => {
    for (const input of [
      "https://chatgpt.com/backend-api",
      "https://chatgpt.com/backend-api/",
      "https://chatgpt.com/backend-api/codex",
      "https://chatgpt.com/backend-api/codex/responses",
    ]) {
      assert.equal(normalizeBaseUrl(input), "https://chatgpt.com/backend-api", input);
    }
  });

  it("builds the models and responses endpoints", () => {
    assert.equal(
      resolveEndpoint(undefined, "responses"),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(
      resolveEndpoint(undefined, "models"),
      "https://chatgpt.com/backend-api/codex/models",
    );
  });
});

describe("account id resolution", () => {
  function tokenWith(payload: unknown): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
  }

  it("reads the account id from the JWT claim", () => {
    const token = tokenWith({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" } });
    assert.equal(extractAccountIdFromToken(token), "acct-jwt");
  });

  it("returns undefined for a token without the claim", () => {
    assert.equal(extractAccountIdFromToken(tokenWith({ sub: "x" })), undefined);
    assert.equal(extractAccountIdFromToken("not-a-jwt"), undefined);
  });

  it("prefers the stored credential over the JWT claim", () => {
    const token = tokenWith({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" } });
    const resolved = resolveAccountId(token, {}, () => ({
      type: "oauth",
      accountId: "acct-stored",
    }));
    assert.equal(resolved, "acct-stored");
  });

  it("falls back to legacy authStorage when readStoredCredential is absent", () => {
    // pi exposed only modelRegistry.authStorage before ~0.80.8; both shapes
    // must keep working, which is why CI runs a two-entry version matrix.
    const token = tokenWith({});
    const legacyRegistry = {
      authStorage: { get: () => ({ type: "oauth", accountId: "acct-legacy" }) },
    };
    assert.equal(resolveAccountId(token, legacyRegistry, null), "acct-legacy");
  });

  it("falls back to the JWT when neither store has an id", () => {
    const token = tokenWith({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" } });
    assert.equal(
      resolveAccountId(token, {}, () => undefined),
      "acct-jwt",
    );
  });
});
