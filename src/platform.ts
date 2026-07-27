/**
 * External binary detection and platform-aware install hints.
 *
 * Covers macOS and Linux only — the platforms pi-glean claims to support. Other
 * platforms get a generic "put it on PATH" hint rather than an invented command.
 */

export type Binary = "ffmpeg" | "ffprobe" | "yt-dlp" | "gh" | "git";

export type Platform = "darwin" | "linux" | "other";

/** What each binary is needed for, used in the missing-binary message. */
const CAPABILITY: Record<Binary, string> = {
  ffmpeg: "video frame extraction",
  ffprobe: "video duration probing",
  "yt-dlp": "YouTube transcripts and stream resolution",
  gh: "GitHub API access for large repos and private repos",
  git: "cloning GitHub repositories",
};

const HINTS: Record<Binary, Record<Platform, string>> = {
  ffmpeg: {
    darwin: "brew install ffmpeg",
    linux: "sudo apt install ffmpeg  (or: sudo dnf install ffmpeg / sudo pacman -S ffmpeg)",
    other: "install ffmpeg and put it on PATH",
  },
  ffprobe: {
    darwin: "brew install ffmpeg",
    linux: "sudo apt install ffmpeg  (or: sudo dnf install ffmpeg / sudo pacman -S ffmpeg)",
    other: "install ffmpeg and put it on PATH",
  },
  "yt-dlp": {
    darwin: "brew install yt-dlp",
    linux: "pipx install yt-dlp  (distro packages are usually too old)",
    other: "pip install -U yt-dlp",
  },
  gh: {
    darwin: "brew install gh",
    linux: "sudo apt install gh  — see https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
    other: "https://cli.github.com",
  },
  git: {
    darwin: "brew install git",
    linux: "sudo apt install git",
    other: "https://git-scm.com/downloads",
  },
};

export function currentPlatform(platform: string = process.platform): Platform {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "other";
}

export function isKnownBinary(name: string): name is Binary {
  return name in HINTS;
}

export function installHint(binary: Binary, platform: string = process.platform): string {
  return HINTS[binary][currentPlatform(platform)];
}

/**
 * The exact wording used whenever a binary turns out to be missing.
 *
 * Accepts any command name because `run()` is not restricted to the five
 * binaries we ship hints for; unknown names get a generic message rather than
 * crashing the error path.
 */
export function missingBinaryMessage(binary: string, platform: string = process.platform): string {
  if (!isKnownBinary(binary)) {
    return `${binary} is not installed or not on PATH.`;
  }
  const lines = [
    `${binary} is not installed or not on PATH — required for ${CAPABILITY[binary]}.`,
    `Install with: ${installHint(binary, platform)}`,
  ];
  if (binary === "ffprobe") lines.push("(ffprobe ships with ffmpeg)");
  return lines.join("\n");
}

/** Runs a probe command; returns true when the binary responded. */
export type BinaryProbe = (binary: Binary) => Promise<boolean>;

const PROBE_ARGS: Record<Binary, string[]> = {
  ffmpeg: ["-version"],
  ffprobe: ["-version"],
  "yt-dlp": ["--version"],
  gh: ["--version"],
  git: ["--version"],
};

/**
 * Generous, because the cost of being wrong is asymmetric.
 *
 * A probe that times out is reported as "not installed", and the hint then
 * tells the user to install what they already have. The five probes run
 * concurrently, and the first execution of a large binary after installation
 * pays macOS's verification cost — that combination exceeded a 5s budget on a
 * real machine. The result is memoized, so this is paid at most once.
 */
const PROBE_TIMEOUT_MS = 20_000;

async function defaultProbe(binary: Binary): Promise<boolean> {
  const { run } = await import("./exec.ts");
  try {
    await run(binary, PROBE_ARGS[binary], { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Memoized availability check. The promise (not the result) is cached so
 * concurrent callers share one probe.
 */
export function createBinaryDetector(probe: BinaryProbe = defaultProbe) {
  const cache = new Map<Binary, Promise<boolean>>();
  return {
    detect(binary: Binary): Promise<boolean> {
      let pending = cache.get(binary);
      if (!pending) {
        pending = probe(binary);
        cache.set(binary, pending);
      }
      return pending;
    },
    reset(): void {
      cache.clear();
    },
  };
}

export const binaries = createBinaryDetector();

export function detectBinary(binary: Binary): Promise<boolean> {
  return binaries.detect(binary);
}
