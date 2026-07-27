/**
 * Local video files.
 *
 * Two capabilities with very different requirements, and the split matters:
 * frame extraction needs only ffmpeg and always works, while whole-video
 * understanding uploads the file to Gemini and needs a key. When the key is
 * missing we return the frames with a note explaining what else was possible —
 * an error there would throw away work that already succeeded.
 */

import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ResolvedConfig } from "../config.ts";
import { GleanError } from "../errors.ts";
import { formatBytes, formatSeconds } from "../format.ts";
import type { ExtractedContent, ExtractOptions } from "../fetch/types.ts";
import { extractFrames, type FrameOptions, probeDuration } from "./frames.ts";
import { planTimestamps } from "./timestamps.ts";

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "m4v",
  "mpeg",
  "mpg",
  "wmv",
  "flv",
]);

/** Gemini truncates beyond roughly an hour; say so instead of losing the tail. */
const GEMINI_MAX_DURATION_SECONDS = 3600;

/** Resolves a local video reference to an absolute path, or null. */
export function localVideoPath(value: string, home: string = homedir()): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let path: string;
  if (trimmed.startsWith("file://")) {
    try {
      path = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  } else if (trimmed.startsWith("~/")) {
    path = resolve(home, trimmed.slice(2));
  } else if (isAbsolute(trimmed) || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    path = resolve(trimmed);
  } else {
    return null;
  }

  const extension = path.toLowerCase().split(".").pop() ?? "";
  return VIDEO_EXTENSIONS.has(extension) ? path : null;
}

export interface VideoDeps {
  config: ResolvedConfig;
  signal?: AbortSignal;
  /** Test seam for ffmpeg. */
  frameRunner?: FrameOptions["runner"];
  /** Test seam for ffprobe. */
  durationRunner?: () => Promise<string>;
  /** Test seam replacing the Gemini upload and query. */
  analyze?: (path: string, prompt: string) => Promise<string>;
  /** Test seam for `stat`. */
  statFile?: (path: string) => Promise<{ size: number }>;
}

async function resolveGemini(
  deps: VideoDeps,
  path: string,
  prompt: string,
): Promise<string | null> {
  if (deps.analyze) return deps.analyze(path, prompt);

  const { resolveCredential } = await import("../credentials.ts");
  const apiKey = await resolveCredential({
    provider: "gemini",
    configuredValue: deps.config.gemini.apiKey,
    environmentValue: process.env.GEMINI_API_KEY,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!apiKey) return null;

  const { analyzeLocalVideo } = await import("./gemini.ts");
  return analyzeLocalVideo(path, prompt, {
    apiKey,
    model: deps.config.video.preferredModel,
    ...(deps.config.gemini.baseUrl ? { baseUrl: deps.config.gemini.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

/** Explains why whole-video understanding is unavailable, and what to do instead. */
function geminiUnavailableNote(reason: string): string {
  return `\n\n_${reason}_`;
}

/**
 * Reads a local video file.
 *
 * Returns null when the reference is not a local video path, so the caller
 * falls through to the ordinary URL handling.
 */
export async function extractLocalVideo(
  reference: string,
  deps: VideoDeps,
  options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
  if (!deps.config.video.enabled) return null;
  const path = localVideoPath(reference);
  if (!path) return null;

  const title = basename(path);

  let size: number;
  try {
    size = (await (deps.statFile ?? stat)(path)).size;
  } catch {
    return {
      url: reference,
      title,
      content: "",
      error: `Local video not found: ${path}`,
    };
  }

  const duration = await probeDuration(path, {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.durationRunner ? { runner: deps.durationRunner } : {}),
  });

  const wantsFrames = options.frames !== undefined || options.timestamp !== undefined;
  const timestamps = planTimestamps(options.timestamp, options.frames, duration, "video");
  if (timestamps.length === 0) {
    throw new GleanError("invalid-request", "The requested timestamps fall outside the video.", {
      source: "video",
    });
  }

  const { frames, errors } = await extractFrames(path, timestamps, {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.frameRunner ? { runner: deps.frameRunner } : {}),
  });

  const facts = [
    `**File:** ${path}`,
    `**Size:** ${formatBytes(size)}`,
    ...(duration ? [`**Duration:** ${formatSeconds(duration)}`] : []),
    `**Frames:** ${frames.length}`,
  ];
  let body = `Frames captured at ${timestamps.map(formatSeconds).join(", ")}.`;
  if (errors.length > 0) body += `\n\nSome frames could not be captured:\n- ${errors.join("\n- ")}`;

  // Whole-video understanding is an addition, never a precondition — a prompt
  // is what asks for it, and everything below degrades to a note.
  if (options.prompt && !wantsFrames) {
    const maxBytes = deps.config.video.maxSizeMB * 1024 * 1024;
    if (size > maxBytes) {
      body += geminiUnavailableNote(
        `${title} is ${formatBytes(size)}, above the configured video.maxSizeMB ` +
          `(${formatBytes(maxBytes)}) for Gemini analysis. Use timestamp/frames for more ffmpeg ` +
          `frames, raise video.maxSizeMB, or compress the file.`,
      );
    } else if (duration !== null && duration > GEMINI_MAX_DURATION_SECONDS) {
      body += geminiUnavailableNote(
        `${title} runs ${formatSeconds(duration)}, beyond the roughly one hour Gemini accepts — ` +
          `it would be silently truncated. Ask about a specific range with timestamp instead.`,
      );
    } else {
      try {
        const answer = await resolveGemini(deps, path, options.prompt);
        if (answer) {
          body = `${answer}\n\n---\n\n${body}`;
        } else {
          body += geminiUnavailableNote(
            "Set GEMINI_API_KEY to have the whole video watched and the question answered; " +
              "only frames were extracted.",
          );
        }
      } catch (error) {
        const message = error instanceof GleanError ? error.displayMessage : String(error);
        body += geminiUnavailableNote(
          `Video analysis failed, so only frames were extracted: ${message}`,
        );
      }
    }
  }

  return {
    url: reference,
    title,
    content: `# ${title}\n\n${facts.join(" · ")}\n\n${body}`,
    error: null,
    via: "video",
    frames,
    ...(duration ? { duration } : {}),
  };
}
