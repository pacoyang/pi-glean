import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CACHE_TTL_MS,
  CUSTOM_TYPE,
  clearResults,
  generateId,
  getAllResults,
  getResult,
  restoreFromSession,
  storeResult,
  stripThumbnails,
  type StoredSearchData,
} from "../src/storage.ts";
import type { ExtractedContent } from "../src/fetch/types.ts";

function ctxWithBranch(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

function custom(customType: string, data: unknown) {
  return { type: "custom", customType, data };
}

function searchRecord(id: string, timestamp: number): StoredSearchData {
  return { id, type: "search", timestamp, queries: [] };
}

beforeEach(() => {
  clearResults();
});

describe("store and retrieve", () => {
  it("round-trips a record", () => {
    storeResult("abc", searchRecord("abc", Date.now()));
    assert.equal(getResult("abc")?.id, "abc");
    assert.equal(getAllResults().length, 1);
  });

  it("returns null for an unknown id", () => {
    assert.equal(getResult("nope"), null);
  });

  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()));
    assert.equal(ids.size, 200);
  });
});

describe("restoreFromSession", () => {
  it("replays only glean-results entries", () => {
    const now = Date.now();
    restoreFromSession(
      ctxWithBranch([
        custom(CUSTOM_TYPE, searchRecord("mine", now)),
        { type: "message", message: {} },
      ]),
      now,
    );
    assert.equal(getAllResults().length, 1);
    assert.equal(getResult("mine")?.id, "mine");
  });

  it("ignores another extension's records so the two can coexist", () => {
    const now = Date.now();
    restoreFromSession(
      ctxWithBranch([custom("web-search-results", searchRecord("theirs", now))]),
      now,
    );
    assert.equal(getAllResults().length, 0);
  });

  it("drops entries older than the TTL", () => {
    const now = Date.now();
    restoreFromSession(
      ctxWithBranch([
        custom(CUSTOM_TYPE, searchRecord("fresh", now - 1000)),
        custom(CUSTOM_TYPE, searchRecord("stale", now - CACHE_TTL_MS - 1)),
      ]),
      now,
    );
    assert.deepEqual(
      getAllResults().map((r) => r.id),
      ["fresh"],
    );
  });

  it("ignores malformed entries", () => {
    const now = Date.now();
    restoreFromSession(
      ctxWithBranch([
        custom(CUSTOM_TYPE, null),
        custom(CUSTOM_TYPE, { id: "", type: "search", timestamp: now, queries: [] }),
        custom(CUSTOM_TYPE, { id: "x", type: "bogus", timestamp: now }),
        custom(CUSTOM_TYPE, { id: "y", type: "search", timestamp: "soon" }),
        custom(CUSTOM_TYPE, { id: "z", type: "fetch", timestamp: now }), // urls missing
      ]),
      now,
    );
    assert.equal(getAllResults().length, 0);
  });

  it("clears previous state so a branch switch does not leak records", () => {
    storeResult("old", searchRecord("old", Date.now()));
    restoreFromSession(ctxWithBranch([]), Date.now());
    assert.equal(getAllResults().length, 0);
  });
});

describe("stripThumbnails", () => {
  it("removes images before a record reaches the session log", () => {
    const withImages: ExtractedContent[] = [
      {
        url: "https://example.com/v",
        title: "clip",
        content: "text",
        error: null,
        duration: 90,
        thumbnail: { data: "AAAA", mimeType: "image/jpeg" },
        frames: [{ data: "BBBB", mimeType: "image/jpeg", timestamp: "0:05" }],
      },
    ];
    const stripped = stripThumbnails(withImages);
    assert.equal(stripped[0]?.thumbnail, undefined);
    assert.equal(stripped[0]?.frames, undefined);
    assert.equal(stripped[0]?.duration, 90, "non-image fields survive");
    assert.ok(withImages[0]?.thumbnail, "input is not mutated");
  });
});
