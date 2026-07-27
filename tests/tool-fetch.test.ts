import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasFullInlineCoverage, mediaBlocks } from "../src/tools/fetch.ts";
import type { ExtractedContent } from "../src/fetch/types.ts";

function content(overrides: Partial<ExtractedContent> = {}): ExtractedContent {
  return { url: "https://example.com/v", title: "Clip", content: "", error: null, ...overrides };
}

function frame(timestamp: string) {
  return { data: `data-${timestamp}`, mimeType: "image/jpeg", timestamp };
}

describe("hasFullInlineCoverage", () => {
  it("is true only when every requested URL came back inline", () => {
    const urls = ["https://a.test", "https://b.test"];
    assert.equal(hasFullInlineCoverage(urls, [content({ url: "https://a.test" })]), false);
    assert.equal(
      hasFullInlineCoverage(urls, [
        content({ url: "https://a.test" }),
        content({ url: "https://b.test" }),
      ]),
      true,
    );
  });

  it("is false when nothing is inline", () => {
    assert.equal(hasFullInlineCoverage(["https://a.test"], []), false);
  });
});

describe("mediaBlocks", () => {
  it("labels each frame with the moment it came from", () => {
    // Without the label the model sees a pile of stills and cannot tell which
    // moment any of them shows.
    const blocks = mediaBlocks([content({ frames: [frame("1:23"), frame("2:30")] })]);
    assert.deepEqual(blocks, [
      { type: "image", data: "data-1:23", mimeType: "image/jpeg" },
      { type: "text", text: "Frame at 1:23" },
      { type: "image", data: "data-2:30", mimeType: "image/jpeg" },
      { type: "text", text: "Frame at 2:30" },
    ]);
  });

  it("falls back to the thumbnail only when there are no frames", () => {
    const thumbnail = { data: "thumb", mimeType: "image/jpeg" };
    assert.deepEqual(mediaBlocks([content({ thumbnail })]), [
      { type: "image", data: "thumb", mimeType: "image/jpeg" },
      { type: "text", text: "Thumbnail for Clip" },
    ]);
    assert.equal(
      mediaBlocks([content({ thumbnail, frames: [frame("0:05")] })]).filter(
        (block) => block.type === "image",
      ).length,
      1,
      "the thumbnail is redundant once real frames exist",
    );
  });

  it("caps how many images reach the model", () => {
    const frames = Array.from({ length: 30 }, (_, index) => frame(`0:${index}`));
    const blocks = mediaBlocks([content({ frames })]);
    assert.equal(blocks.filter((block) => block.type === "image").length, 12);
  });

  it("emits nothing for an ordinary page", () => {
    assert.deepEqual(mediaBlocks([content({ content: "# Article" })]), []);
  });
});
