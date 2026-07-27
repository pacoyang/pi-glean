import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearResults, getAllResults, getResult } from "../src/storage.ts";
import {
  abortPendingFetches,
  markSessionActive,
  pendingCount,
  startBackgroundFetch,
} from "../src/tools/prefetch.ts";
import { sliceWithContinuation } from "../src/tools/get-content.ts";
import type { Lookup } from "../src/fetch/ssrf.ts";
import { testConfig } from "./helpers/fixtures.ts";

const PUBLIC_LOOKUP: Lookup = async () => [{ address: "93.184.216.34", family: 4 }];

interface SentMessage {
  customType: string;
  content: string;
  triggerTurn: boolean;
}

function fakePi() {
  const messages: SentMessage[] = [];
  const entries: unknown[] = [];
  const pi = {
    appendEntry(_type: string, data: unknown) {
      entries.push(data);
    },
    sendMessage(
      message: { customType: string; content: string },
      options?: { triggerTurn?: boolean },
    ) {
      messages.push({
        customType: message.customType,
        content: message.content,
        triggerTurn: options?.triggerTurn === true,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, messages, entries };
}

const ARTICLE = `<!doctype html><html><head><title>Doc</title></head><body><article>${"<p>Substantial body text that Readability will keep.</p>".repeat(20)}</article></body></html>`;

function htmlFetch(delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

/** Waits for the background chain to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && pendingCount() > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  clearResults();
  markSessionActive(true);
});

afterEach(() => {
  abortPendingFetches();
  markSessionActive(true);
});

describe("push model", () => {
  it("returns an id immediately without waiting for the fetch", async () => {
    const { pi, messages } = fakePi();
    const fetchId = startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(30),
      lookup: PUBLIC_LOOKUP,
    });

    // The whole point: the caller does not block on the network.
    assert.ok(fetchId);
    assert.deepEqual(messages, [], "nothing is sent before the fetch completes");

    await settle();
    assert.equal(messages.length, 1);
  });

  it("wakes the agent when the content lands", async () => {
    const { pi, messages } = fakePi();
    const fetchId = startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(),
      lookup: PUBLIC_LOOKUP,
    });
    await settle();

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.customType, "glean-content-ready");
    assert.equal(messages[0]?.triggerTurn, true, "a ready notification must wake the agent");
    assert.match(messages[0]?.content ?? "", new RegExp(fetchId!));
  });

  it("uses an id separate from the search that requested it", async () => {
    const { pi } = fakePi();
    const fetchId = startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(),
      lookup: PUBLIC_LOOKUP,
    });
    await settle();
    // The search record is already written and sent by now, so the prefetch
    // needs its own id rather than mutating that one.
    const stored = getResult(fetchId!);
    assert.equal(stored?.type, "fetch");
    assert.equal(stored?.urls?.length, 1);
  });

  it("returns null for an empty URL list", () => {
    const { pi } = fakePi();
    assert.equal(
      startBackgroundFetch([], { pi, config: testConfig(), lookup: PUBLIC_LOOKUP }),
      null,
    );
  });
});

describe("failure handling", () => {
  it("notifies without interrupting the current turn", async () => {
    const { pi, messages } = fakePi();
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: failing,
      lookup: PUBLIC_LOOKUP,
    });
    await settle();

    // extractAll resolves per-URL errors, so this still reports as ready.
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content.includes("0/1"), true);
  });
});

describe("session guards", () => {
  it("writes nothing once the session has ended", async () => {
    const { pi, messages, entries } = fakePi();
    startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(20),
      lookup: PUBLIC_LOOKUP,
    });

    // Session ends while the fetch is still in flight.
    markSessionActive(false);
    await settle();

    assert.deepEqual(messages, [], "a dead session must not be woken");
    assert.deepEqual(entries, [], "and must not gain new records");
    assert.equal(getAllResults().length, 0);
  });

  it("stops sending after an abort", async () => {
    const { pi, messages } = fakePi();
    startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(20),
      lookup: PUBLIC_LOOKUP,
    });

    abortPendingFetches();
    await settle();
    assert.deepEqual(messages, []);
  });

  it("clears the pending map when the fetch finishes", async () => {
    const { pi } = fakePi();
    startBackgroundFetch(["https://a.example/1"], {
      pi,
      config: testConfig(),
      fetchImpl: htmlFetch(),
      lookup: PUBLIC_LOOKUP,
    });
    await settle();
    assert.equal(pendingCount(), 0);
  });
});

describe("sliceWithContinuation", () => {
  it("appends a pointer while content remains", () => {
    const { text, nextOffset } = sliceWithContinuation(
      "abcdefghij",
      { offset: 0, limit: 4 },
      (next) => `next=${next}`,
    );
    assert.match(text, /^abcd/);
    assert.match(text, /next=4/);
    assert.equal(nextOffset, 4);
  });

  it("omits the pointer on the final slice", () => {
    const { text, nextOffset } = sliceWithContinuation(
      "abcdefghij",
      { offset: 8, limit: 100 },
      (next) => `next=${next}`,
    );
    assert.equal(text, "ij");
    assert.equal(nextOffset, null);
  });

  it("terminates: repeated slicing reaches the end", () => {
    const body = "x".repeat(1000);
    let offset = 0;
    let iterations = 0;
    for (;;) {
      const { nextOffset } = sliceWithContinuation(body, { offset, limit: 300 }, () => "");
      iterations++;
      if (nextOffset === null) break;
      assert.ok(nextOffset > offset, "offset must advance");
      offset = nextOffset;
      assert.ok(iterations < 100, "must not loop forever");
    }
    assert.equal(iterations, 4);
  });
});
