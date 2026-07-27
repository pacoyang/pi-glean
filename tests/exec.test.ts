import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import { mapFfmpegError, mapYtDlpError, run, runText } from "../src/exec.ts";

describe("run", () => {
  it("returns stdout as a Buffer and stderr as text", async () => {
    const result = await run(
      "node",
      ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"],
      {
        timeoutMs: 10_000,
      },
    );
    assert.ok(Buffer.isBuffer(result.stdout));
    assert.equal(result.stdout.toString(), "hi");
    assert.equal(result.stderr, "warn");
  });

  it("maps ENOENT to missing_binary with an install hint", async () => {
    await assert.rejects(
      () => run("yt-dlp-definitely-not-installed", [], { timeoutMs: 5000 }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "missing_binary");
        assert.match(error.message, /not installed or not on PATH/);
        return true;
      },
    );
  });

  it("times out and kills the child", async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        run("node", ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200, killGraceMs: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "timeout");
        assert.match(error.message, /timed out after 200ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 10_000, "must not wait for the child's own lifetime");
  });

  it("propagates an AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () =>
        run("node", ["-e", "setTimeout(() => {}, 60000)"], {
          timeoutMs: 30_000,
          signal: controller.signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "aborted");
        return true;
      },
    );
  });

  it("classifies a maxBuffer overflow", async () => {
    await assert.rejects(
      () =>
        run("node", ["-e", "process.stdout.write('x'.repeat(100000))"], {
          timeoutMs: 10_000,
          maxBuffer: 16,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "invalid-response");
        return true;
      },
    );
  });

  it("preserves stderr on a non-zero exit so callers can map it", async () => {
    await assert.rejects(
      () =>
        run("node", ["-e", "process.stderr.write('boom detail'); process.exit(3)"], {
          timeoutMs: 10_000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "transient");
        assert.match(error.message, /boom detail/);
        return true;
      },
    );
  });

  it("runText decodes stdout", async () => {
    const result = await runText("node", ["-e", "process.stdout.write('text')"], {
      timeoutMs: 10_000,
    });
    assert.equal(result.stdout, "text");
  });
});

describe("error mapping", () => {
  it("recognises an expired stream URL from ffmpeg", () => {
    const mapped = mapFfmpegError(
      new GleanError("transient", "ffmpeg failed: HTTP error 403 Forbidden"),
    );
    assert.equal(mapped.kind, "transient");
    assert.match(mapped.message, /may have expired/);
  });

  it("passes other ffmpeg errors through unchanged", () => {
    const original = new GleanError("timeout", "ffmpeg timed out after 30000ms");
    assert.equal(mapFfmpegError(original), original);
  });

  it("classifies yt-dlp private/unavailable videos", () => {
    const mapped = mapYtDlpError(new GleanError("transient", "yt-dlp failed: Private video"));
    assert.equal(mapped.kind, "not_found");
  });

  it("classifies yt-dlp age restriction and offers the escape hatch", () => {
    const mapped = mapYtDlpError(
      new GleanError("transient", "yt-dlp failed: Sign in to confirm your age"),
    );
    assert.equal(mapped.kind, "auth");
    assert.match(mapped.hint ?? "", /ytDlpArgs/);
  });

  it("classifies yt-dlp region blocks and live streams", () => {
    assert.equal(
      mapYtDlpError(new GleanError("transient", "yt-dlp failed: not available in your country"))
        .kind,
      "unsupported",
    );
    assert.equal(
      mapYtDlpError(new GleanError("transient", "yt-dlp failed: This is live event")).kind,
      "unsupported",
    );
  });
});
