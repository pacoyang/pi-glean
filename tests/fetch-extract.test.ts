import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractAll, extractUrl, isLikelyJsRendered, isPdf } from "../src/fetch/extract.ts";
import { JINA_READER_BASE, fetchViaJina } from "../src/fetch/jina.ts";
import { normalizeFetchParams } from "../src/fetch/params.ts";
import { GleanError } from "../src/errors.ts";
import type { Lookup } from "../src/fetch/ssrf.ts";
import { testConfig } from "./helpers/fixtures.ts";

const PUBLIC_LOOKUP: Lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const PRIVATE_LOOKUP: Lookup = async () => [{ address: "10.0.0.1", family: 4 }];

function htmlPage(body: string, title = "Test Page"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><article>${body}</article></body></html>`;
}

const LONG_ARTICLE = `<h1>React 19</h1>${"<p>React 19 removes forwardRef because ref is now an ordinary prop.</p>".repeat(20)}`;

interface Routes {
  [url: string]: Response | (() => Response);
}

function routed(routes: Routes): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("html extraction", () => {
  it("converts an article to markdown", async () => {
    const { fetch } = routed({ "https://example.com/post": html(htmlPage(LONG_ARTICLE)) });
    const result = await extractUrl("https://example.com/post", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.equal(result.error, null);
    assert.match(result.content, /# React 19/);
    assert.match(result.content, /forwardRef/);
    assert.equal(result.via, "http");
  });

  it("returns non-HTML bodies verbatim", async () => {
    const { fetch } = routed({
      "https://api.example.com/data.json": new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      }),
    });
    const result = await extractUrl("https://api.example.com/data.json", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.equal(result.content, '{"ok":true}');
    assert.equal(result.via, "raw");
  });
});

describe("fallback chain", () => {
  it("falls through to Jina for a JS-rendered page", async () => {
    const spa = `<!doctype html><html><body><div id="root"></div>${"<script>var x=1;</script>".repeat(5)}</body></html>`;
    const jinaBody = `Title: SPA\n\nMarkdown Content:\n${"Real content recovered by rendering. ".repeat(20)}`;
    const { fetch, calls } = routed({
      "https://spa.example/app": html(spa),
      [`${JINA_READER_BASE}https://spa.example/app`]: new Response(jinaBody),
    });

    const result = await extractUrl("https://spa.example/app", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.equal(result.error, null);
    assert.equal(result.via, "jina");
    assert.match(result.content, /Real content recovered/);
    assert.ok(calls.some((url) => url.startsWith(JINA_READER_BASE)));
  });

  it("does not call Jina for unsupported content types", async () => {
    // Rendering a zip would not help; the round trip is pure cost.
    const { fetch, calls } = routed({
      "https://example.com/a.zip": new Response("PK", {
        headers: { "content-type": "application/zip" },
      }),
    });
    const result = await extractUrl("https://example.com/a.zip", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.match(result.error ?? "", /Unsupported content type/);
    assert.equal(calls.filter((url) => url.startsWith(JINA_READER_BASE)).length, 0);
  });

  it("does not call Jina when the response is too large", async () => {
    const { fetch, calls } = routed({
      "https://example.com/big": new Response("x", {
        headers: { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) },
      }),
    });
    const result = await extractUrl("https://example.com/big", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.match(result.error ?? "", /Response too large/);
    assert.equal(calls.filter((url) => url.startsWith(JINA_READER_BASE)).length, 0);
  });

  it("skips Jina entirely when the fallback is disabled", async () => {
    const config = testConfig();
    config.fetch.jina.enabled = false;
    const { fetch, calls } = routed({ "https://example.com/x": html("<body></body>") });
    await extractUrl("https://example.com/x", { config, fetchImpl: fetch, lookup: PUBLIC_LOOKUP });
    assert.equal(calls.filter((url) => url.startsWith(JINA_READER_BASE)).length, 0);
  });

  it("reports the original error when Jina also fails", async () => {
    const { fetch } = routed({
      "https://example.com/x": html("<body></body>"),
      [`${JINA_READER_BASE}https://example.com/x`]: new Response("Loading...", { status: 200 }),
    });
    const result = await extractUrl("https://example.com/x", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PUBLIC_LOOKUP,
    });
    assert.match(result.error ?? "", /Could not extract readable content|JavaScript-rendered/);
    assert.match(result.error ?? "", /Try searching for the topic instead/);
  });
});

describe("SSRF is applied before any request", () => {
  it("rejects a private target without fetching", async () => {
    const { fetch, calls } = routed({});
    const result = await extractUrl("https://internal.example/secret", {
      config: testConfig(),
      fetchImpl: fetch,
      lookup: PRIVATE_LOOKUP,
    });
    assert.match(result.error ?? "", /Blocked internal address/);
    assert.deepEqual(calls, [], "nothing may be requested for a blocked target");
  });
});

describe("Jina private-host guard", () => {
  it("refuses to forward an internal URL to a third-party renderer", async () => {
    // ssrf.allowRanges can permit an internal address locally, but sending its
    // URL to r.jina.ai would disclose it to a third party.
    await assert.rejects(
      () =>
        fetchViaJina("https://internal.corp/secret", {
          lookup: PRIVATE_LOOKUP,
          fetchImpl: (async () =>
            new Response("should never be reached")) as unknown as typeof fetch,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "ssrf");
        assert.match(error.message, /Refusing to send/);
        return true;
      },
    );
  });

  it("sends Authorization only when a key is configured", async () => {
    const seen: Array<Record<string, string>> = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      seen.push(headers);
      return new Response(`Markdown Content:\n${"content ".repeat(40)}`);
    }) as unknown as typeof fetch;

    await fetchViaJina("https://example.com/a", { fetchImpl: impl, lookup: PUBLIC_LOOKUP });
    assert.equal(seen[0]?.authorization, undefined);

    await fetchViaJina("https://example.com/a", {
      fetchImpl: impl,
      lookup: PUBLIC_LOOKUP,
      apiKey: "jina-key",
    });
    assert.equal(seen[1]?.authorization, "Bearer jina-key");
  });

  it("names JINA_API_KEY when the free tier is exhausted", async () => {
    const impl = (async () =>
      new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchViaJina("https://example.com/a", { fetchImpl: impl, lookup: PUBLIC_LOOKUP }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "quota");
        assert.match(error.hint ?? "", /JINA_API_KEY/);
        return true;
      },
    );
  });

  it("returns null for a response with no markdown marker", async () => {
    const impl = (async () => new Response("<html>nope</html>")) as unknown as typeof fetch;
    assert.equal(
      await fetchViaJina("https://example.com/a", { fetchImpl: impl, lookup: PUBLIC_LOOKUP }),
      null,
    );
  });

  it("rejects Jina's own failure placeholders", async () => {
    for (const body of [
      "Markdown Content:\nLoading...",
      "Markdown Content:\nPlease enable JavaScript",
      "Markdown Content:\nshort",
    ]) {
      const impl = (async () => new Response(body)) as unknown as typeof fetch;
      assert.equal(
        await fetchViaJina("https://example.com/a", { fetchImpl: impl, lookup: PUBLIC_LOOKUP }),
        null,
        body,
      );
    }
  });
});

describe("concurrency", () => {
  it("runs at most three fetches at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return html(htmlPage(LONG_ARTICLE));
    }) as unknown as typeof fetch;

    const urls = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
    const results = await extractAll(urls, {
      config: testConfig(),
      fetchImpl: impl,
      lookup: PUBLIC_LOOKUP,
    });

    assert.equal(results.length, 9);
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });
});

describe("heuristics", () => {
  it("detects a JS-rendered shell", () => {
    const spa = `<html><body><div id="root"></div>${"<script>1</script>".repeat(5)}</body></html>`;
    assert.equal(isLikelyJsRendered(spa), true);
  });

  it("does not flag a page with real text", () => {
    const page = `<html><body>${"<p>Plenty of actual prose here for readers.</p>".repeat(30)}<script>1</script></body></html>`;
    assert.equal(isLikelyJsRendered(page), false);
  });

  it("recognises PDFs by content type and by suffix", () => {
    assert.equal(isPdf("https://x.example/a", "application/pdf"), true);
    assert.equal(isPdf("https://arxiv.org/pdf/1706.03762.pdf"), true);
    assert.equal(isPdf("https://x.example/a.html", "text/html"), false);
  });
});

describe("parameter normalization", () => {
  it("prefers the urls array and dedupes it", () => {
    const { urlList } = normalizeFetchParams({
      url: "https://ignored.example",
      urls: ["https://a.example", "https://a.example", "https://b.example"],
    });
    assert.deepEqual(urlList, ["https://a.example", "https://b.example"]);
  });

  it("strips a leading @ that models sometimes add", () => {
    assert.deepEqual(normalizeFetchParams({ url: "@./clip.mp4" }).urlList, ["./clip.mp4"]);
  });

  it("ignores frames:1 on its own", () => {
    // A lone frames:1 is just the default single grab and means nothing.
    assert.equal(normalizeFetchParams({ url: "u", frames: 1 }).options.frames, undefined);
    assert.equal(normalizeFetchParams({ url: "u", frames: 4 }).options.frames, 4);
    assert.equal(
      normalizeFetchParams({ url: "u", frames: 1, timestamp: "1:23" }).options.frames,
      1,
      "with a timestamp, frames:1 is meaningful",
    );
  });

  it("drops empty and non-string values", () => {
    assert.deepEqual(normalizeFetchParams({ url: "   " }).urlList, []);
    assert.deepEqual(normalizeFetchParams({ urls: [1, null, "https://a.example"] }).urlList, [
      "https://a.example",
    ]);
    assert.equal(normalizeFetchParams({ url: "u", prompt: "  " }).options.prompt, undefined);
  });
});
