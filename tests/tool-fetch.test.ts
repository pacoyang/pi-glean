import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFetchTool, mediaBlocks } from "../src/tools/fetch.ts";
import { testConfig } from "./helpers/fixtures.ts";
import type { ExtractedContent } from "../src/fetch/types.ts";

function content(overrides: Partial<ExtractedContent> = {}): ExtractedContent {
  return { url: "https://example.com/v", title: "Clip", content: "", error: null, ...overrides };
}

function frame(timestamp: string) {
  return { data: `data-${timestamp}`, mimeType: "image/jpeg", timestamp };
}

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

describe("live configuration", () => {
  it("consults the config on every execute, not once at build time", async () => {
    // The tool object outlives the config it was built from: pi reloads on
    // session start and tree jump, once cwd and project trust are known.
    // Capturing froze every tool on the startup snapshot, so a trusted
    // project's settings never reached them.
    let current = testConfig();
    let reads = 0;
    const getConfig = () => {
      reads++;
      return current;
    };

    const tool = buildFetchTool({} as never, { getConfig });
    const atBuild = reads;

    await tool.execute("id", { url: "" } as never, undefined, undefined, {} as never);
    assert.ok(reads > atBuild, "execute never asked for the current config");

    // And it is the replacement that is seen, not the original object.
    current = testConfig({ fetch: { ...current.fetch, maxInlineChars: 1234 } });
    const before = reads;
    await tool.execute("id", { url: "" } as never, undefined, undefined, {} as never);
    assert.ok(reads > before);
  });
});
