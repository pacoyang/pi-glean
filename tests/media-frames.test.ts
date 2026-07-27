import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import { extractFrame, extractFrames, probeDuration } from "../src/media/frames.ts";
import type { FrameData } from "../src/fetch/types.ts";

function jpeg(): FrameData {
  return { data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"), mimeType: "image/jpeg" };
}

describe("concurrency", () => {
  it("extracts frames genuinely in parallel", async () => {
    // The regression this guards: upstream used execFileSync, so its
    // Promise.all over timestamps ran strictly serially — twelve frames could
    // block the event loop for minutes.
    let inFlight = 0;
    let peak = 0;

    const { frames } = await extractFrames("video.mp4", [0, 10, 20, 30, 40, 50], {
      runner: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        return jpeg();
      },
    });

    assert.equal(frames.length, 6);
    assert.ok(peak > 1, `frames ran one at a time (peak ${peak})`);
  });

  it("caps how many ffmpeg processes run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await extractFrames(
      "video.mp4",
      Array.from({ length: 12 }, (_, i) => i * 5),
      {
        runner: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return jpeg();
        },
      },
    );
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  it("finishes far faster than a serial run would", async () => {
    const started = Date.now();
    await extractFrames("video.mp4", [0, 10, 20], {
      runner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return jpeg();
      },
    });
    // Serial would be ~120ms; three concurrent slots should land near 40.
    assert.ok(Date.now() - started < 110, "extraction appears to be serial");
  });
});

describe("partial failure", () => {
  it("keeps the frames that worked and reports the ones that did not", async () => {
    const { frames, errors } = await extractFrames("video.mp4", [0, 10, 20], {
      runner: async (seconds) => {
        if (seconds === 10) throw new GleanError("transient", "ffmpeg failed: bad seek");
        return jpeg();
      },
    });
    assert.equal(frames.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /0:10/, "the failing timestamp is named");
    assert.match(errors[0]!, /bad seek/);
  });

  it("labels each frame with its position", async () => {
    const { frames } = await extractFrames("video.mp4", [0, 83, 5025], {
      runner: async () => jpeg(),
    });
    assert.deepEqual(
      frames.map((frame) => frame.timestamp),
      ["0:00", "1:23", "1:23:45"],
    );
  });

  it("returns nothing rather than throwing when every frame fails", async () => {
    const { frames, errors } = await extractFrames("video.mp4", [0, 10], {
      runner: async () => {
        throw new GleanError("missing_binary", "ffmpeg is not installed or not on PATH");
      },
    });
    assert.deepEqual(frames, []);
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /not installed/);
  });
});

describe("extractFrame", () => {
  it("rejects an empty ffmpeg result", async () => {
    await assert.rejects(
      () =>
        extractFrame("video.mp4", 0, {
          runner: async () => {
            throw new GleanError("invalid-response", "ffmpeg produced no frame data");
          },
        }),
      /no frame data/,
    );
  });

  it("returns base64 JPEG bytes", async () => {
    const frame = await extractFrame("video.mp4", 5, { runner: async () => jpeg() });
    assert.equal(frame.mimeType, "image/jpeg");
    assert.ok(frame.data.length > 0);
  });
});

describe("probeDuration", () => {
  it("parses ffprobe output", async () => {
    assert.equal(await probeDuration("v.mp4", { runner: async () => "123.456\n" }), 123.456);
  });

  it("returns null for unusable output", async () => {
    assert.equal(await probeDuration("v.mp4", { runner: async () => "N/A\n" }), null);
    assert.equal(await probeDuration("v.mp4", { runner: async () => "" }), null);
    assert.equal(await probeDuration("v.mp4", { runner: async () => "0\n" }), null);
  });

  it("surfaces a missing ffprobe rather than reporting unknown", async () => {
    // "Unknown duration" and "you have not installed ffmpeg" need different
    // responses from the caller.
    await assert.rejects(
      () =>
        probeDuration("v.mp4", {
          runner: async () => {
            throw new GleanError("missing_binary", "ffprobe is not installed or not on PATH");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "missing_binary");
        return true;
      },
    );
  });

  it("treats other failures as unknown duration", async () => {
    assert.equal(
      await probeDuration("v.mp4", {
        runner: async () => {
          throw new GleanError("transient", "ffprobe failed: moov atom not found");
        },
      }),
      null,
    );
  });
});
