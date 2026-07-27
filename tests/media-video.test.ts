import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractLocalVideo, localVideoPath } from "../src/media/video.ts";
import { planTimestamps } from "../src/media/timestamps.ts";
import { GleanError } from "../src/errors.ts";
import type { FrameData } from "../src/fetch/types.ts";
import { testConfig } from "./helpers/fixtures.ts";

function jpeg(): FrameData {
  return { data: "///", mimeType: "image/jpeg" };
}

const config = testConfig();

/** A readable 10 MiB, 120-second file with working ffmpeg. */
function workingDeps(overrides: Record<string, unknown> = {}) {
  return {
    config,
    statFile: async () => ({ size: 10 * 1024 * 1024 }),
    durationRunner: async () => "120\n",
    frameRunner: async () => jpeg(),
    ...overrides,
  };
}

describe("localVideoPath", () => {
  it("accepts the path shapes a model actually produces", () => {
    assert.equal(localVideoPath("/videos/demo.mp4"), "/videos/demo.mp4");
    assert.ok(localVideoPath("./demo.mov")?.endsWith("/demo.mov"));
    assert.ok(localVideoPath("../clips/demo.webm")?.endsWith("/clips/demo.webm"));
    assert.equal(localVideoPath("file:///videos/demo.mkv"), "/videos/demo.mkv");
    assert.equal(localVideoPath("~/demo.mp4", "/home/paco"), "/home/paco/demo.mp4");
  });

  it("declines remote URLs, so nothing bypasses the SSRF check", () => {
    for (const value of [
      "https://example.com/demo.mp4",
      "http://example.com/demo.mp4",
      "ftp://example.com/demo.mp4",
    ]) {
      assert.equal(localVideoPath(value), null, value);
    }
  });

  it("declines paths that are not videos", () => {
    assert.equal(localVideoPath("/etc/passwd"), null);
    assert.equal(localVideoPath("./notes.md"), null);
    assert.equal(localVideoPath("demo.mp4"), null, "a bare filename is too ambiguous to guess at");
    assert.equal(localVideoPath("   "), null);
  });
});

describe("planTimestamps", () => {
  it("spreads a range", () => {
    assert.deepEqual(planTimestamps("1:00-2:00", 3, 600, "video"), [60, 90, 120]);
  });

  it("captures exactly one frame for a point", () => {
    assert.deepEqual(planTimestamps("1:23", 6, 600, "video"), [83]);
  });

  it("samples the whole file when no timestamp is given", () => {
    const timestamps = planTimestamps(undefined, 3, 100, "video");
    assert.equal(timestamps.length, 3);
    assert.ok(timestamps[0]! > 0 && timestamps.at(-1)! < 100);
  });

  it("still returns an opening frame when the duration is unknown", () => {
    assert.deepEqual(planTimestamps(undefined, 6, null, "video"), [0]);
  });

  it("drops points past the end of the file", () => {
    assert.deepEqual(planTimestamps("5:00", 1, 60, "video"), []);
  });

  it("names the source in a parse error", () => {
    assert.throws(
      () => planTimestamps("half past three", 1, 600, "youtube"),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "schema");
        assert.equal(error.source, "youtube");
        return true;
      },
    );
  });
});

describe("extractLocalVideo", () => {
  it("returns null for anything that is not a local video", async () => {
    assert.equal(await extractLocalVideo("https://example.com/a.mp4", { config }), null);
    assert.equal(await extractLocalVideo("./notes.md", { config }), null);
  });

  it("returns null when local video handling is switched off", async () => {
    const off = testConfig({ video: { ...config.video, enabled: false } });
    assert.equal(await extractLocalVideo("/v/demo.mp4", { config: off }), null);
  });

  it("extracts frames with no API key at all", async () => {
    const result = await extractLocalVideo("/v/demo.mp4", workingDeps(), {
      timestamp: "0:10-0:30",
      frames: 3,
    });

    assert.ok(result);
    assert.equal(result.error, null);
    assert.equal(result.via, "video");
    assert.deepEqual(
      result.frames?.map((frame) => frame.timestamp),
      ["0:10", "0:20", "0:30"],
    );
    assert.equal(result.duration, 120);
    assert.match(result.content, /\*\*Size:\*\* 10\.0 MiB/);
  });

  it("reports a missing file as an error, not a crash", async () => {
    const result = await extractLocalVideo("/v/gone.mp4", {
      config,
      statFile: async () => {
        throw new Error("ENOENT");
      },
    });

    assert.ok(result);
    assert.match(result.error!, /not found/);
  });

  it("prepends the answer when Gemini is configured", async () => {
    const seen: Array<{ path: string; prompt: string }> = [];
    const result = await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({
        analyze: async (path: string, prompt: string) => {
          seen.push({ path, prompt });
          return "A cat knocks a glass off a table.";
        },
      }),
      { prompt: "What happens?" },
    );

    assert.ok(result);
    assert.equal(result.error, null);
    assert.deepEqual(seen, [{ path: "/v/demo.mp4", prompt: "What happens?" }]);
    assert.match(result.content, /A cat knocks a glass off a table\./);
    // The frames are still there — analysis adds to the result, never replaces it.
    assert.ok((result.frames?.length ?? 0) > 0);
  });

  it("returns frames with a note when no key is configured, rather than failing", async () => {
    // The whole point of the frames path is that it works without credentials.
    const result = await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({ analyze: async () => null }),
      { prompt: "What happens?" },
    );

    assert.ok(result);
    assert.equal(result.error, null, "a missing optional key must not fail the extraction");
    assert.ok((result.frames?.length ?? 0) > 0);
    assert.match(result.content, /GEMINI_API_KEY/);
  });

  it("keeps the frames when the analysis call itself fails", async () => {
    const result = await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({
        analyze: async () => {
          throw new GleanError("quota", "daily limit reached");
        },
      }),
      { prompt: "What happens?" },
    );

    assert.ok(result);
    assert.equal(result.error, null);
    assert.ok((result.frames?.length ?? 0) > 0);
    assert.match(result.content, /daily limit reached/);
  });

  it("explains an oversized file instead of uploading it", async () => {
    let uploaded = false;
    const result = await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({
        statFile: async () => ({ size: 90 * 1024 * 1024 }),
        analyze: async () => {
          uploaded = true;
          return "never";
        },
      }),
      { prompt: "What happens?" },
    );

    assert.ok(result);
    assert.equal(uploaded, false);
    assert.equal(result.error, null);
    // Every way forward, not just the refusal.
    assert.match(result.content, /video\.maxSizeMB/);
    assert.match(result.content, /90\.0 MiB/);
    assert.match(result.content, /compress/);
  });

  it("refuses to let a long video be silently truncated", async () => {
    let uploaded = false;
    const result = await extractLocalVideo(
      "/v/long.mp4",
      workingDeps({
        durationRunner: async () => "7200\n",
        analyze: async () => {
          uploaded = true;
          return "never";
        },
      }),
      { prompt: "What happens?" },
    );

    assert.ok(result);
    assert.equal(uploaded, false, "Gemini would have dropped the second hour without a word");
    assert.match(result.content, /one hour/);
    assert.match(result.content, /timestamp/);
  });

  it("does not reach for analysis when frames were what was asked for", async () => {
    let called = false;
    await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({
        analyze: async () => {
          called = true;
          return "unused";
        },
      }),
      { prompt: "What happens at this point?", timestamp: "0:30" },
    );
    assert.equal(called, false);
  });

  it("keeps going when ffmpeg cannot produce some frames", async () => {
    const result = await extractLocalVideo(
      "/v/demo.mp4",
      workingDeps({
        frameRunner: async (seconds: number) => {
          if (seconds === 20) throw new GleanError("transient", "ffmpeg failed: bad seek");
          return jpeg();
        },
      }),
      { timestamp: "0:10-0:30", frames: 3 },
    );

    assert.ok(result);
    assert.equal(result.error, null);
    assert.equal(result.frames?.length, 2);
    assert.match(result.content, /bad seek/);
  });
});
