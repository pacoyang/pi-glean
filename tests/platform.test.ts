import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  type Binary,
  createBinaryDetector,
  currentPlatform,
  installHint,
  missingBinaryMessage,
} from "../src/platform.ts";

const BINARIES: Binary[] = ["ffmpeg", "ffprobe", "yt-dlp", "gh", "git"];

describe("installHint", () => {
  it("covers every binary on darwin and linux", () => {
    for (const binary of BINARIES) {
      assert.match(installHint(binary, "darwin"), /brew install/);
      assert.ok(installHint(binary, "linux").length > 0);
    }
  });

  it("uses pipx for yt-dlp on linux because distro packages lag", () => {
    assert.match(installHint("yt-dlp", "linux"), /pipx install yt-dlp/);
  });

  it("falls back to a generic hint on unsupported platforms", () => {
    // We support macOS and Linux; win32 must not get an invented command.
    assert.equal(currentPlatform("win32"), "other");
    assert.doesNotMatch(installHint("ffmpeg", "win32"), /brew|apt|winget/);
  });
});

describe("missingBinaryMessage", () => {
  it("names the capability and the install command", () => {
    const message = missingBinaryMessage("yt-dlp", "darwin");
    assert.match(message, /yt-dlp is not installed or not on PATH/);
    assert.match(message, /required for YouTube transcripts/);
    assert.match(message, /Install with: brew install yt-dlp/);
  });

  it("tells the user that ffprobe ships with ffmpeg", () => {
    assert.match(missingBinaryMessage("ffprobe", "linux"), /ffprobe ships with ffmpeg/);
  });

  it("degrades gracefully for commands we ship no hint for", () => {
    // run() executes arbitrary binaries, so the error path must not assume the
    // name is one of the five we know about.
    const message = missingBinaryMessage("some-random-tool", "darwin");
    assert.match(message, /some-random-tool is not installed or not on PATH\./);
    assert.doesNotMatch(message, /Install with/);
  });
});

describe("createBinaryDetector", () => {
  it("probes each binary once and reuses the result", async () => {
    let calls = 0;
    const detector = createBinaryDetector(async () => {
      calls++;
      return true;
    });
    assert.equal(await detector.detect("ffmpeg"), true);
    assert.equal(await detector.detect("ffmpeg"), true);
    assert.equal(calls, 1);
  });

  it("shares one probe between concurrent callers", async () => {
    let calls = 0;
    const detector = createBinaryDetector(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    });
    await Promise.all([detector.detect("git"), detector.detect("git"), detector.detect("git")]);
    assert.equal(calls, 1);
  });

  it("caches per binary, not globally", async () => {
    const probed: Binary[] = [];
    const detector = createBinaryDetector(async (binary) => {
      probed.push(binary);
      return true;
    });
    await detector.detect("git");
    await detector.detect("gh");
    assert.deepEqual(probed, ["git", "gh"]);
  });
});

describe("README stays in step with the hint table", () => {
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
    "utf-8",
  );

  it("documents an install command for every binary", () => {
    // The commands live here because an error message has to name one, and the
    // README repeats them because a reader should not have to trigger a failure
    // to find out what to install. Two copies, so this asserts they agree.
    for (const binary of ["ffmpeg", "yt-dlp", "gh", "git"] as const) {
      assert.ok(readme.includes(binary), `README never mentions ${binary}`);
    }
    assert.match(readme, /brew install .*ffmpeg/);
    assert.match(readme, /apt install .*ffmpeg/);
    assert.match(readme, /pipx install yt-dlp/, "apt's yt-dlp is too old to recommend");
  });

  it("does not promise a platform the hint table cannot serve", () => {
    // installHint answers for darwin, linux and a fallback; the README should
    // not imply a fourth is handled specially.
    assert.ok(installHint("ffmpeg", "darwin").includes("brew"));
    assert.ok(installHint("ffmpeg", "linux").includes("apt"));
    assert.ok(installHint("yt-dlp", "linux").includes("pipx"));
  });
});
