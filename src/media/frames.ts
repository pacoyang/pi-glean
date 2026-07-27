/**
 * Frame extraction via ffmpeg.
 *
 * Upstream used `execFileSync`, which blocks the event loop for up to 30s per
 * frame. Its `Promise.all` over timestamps therefore looked parallel but ran
 * strictly serially — twelve frames could freeze the UI for minutes. These are
 * genuinely concurrent, bounded so a long extraction does not saturate the box.
 *
 * Frames need no API key at all; only whole-video understanding does.
 */

import pLimit from "p-limit";
import { GleanError } from "../errors.ts";
import { mapFfmpegError, run, runText } from "../exec.ts";
import { formatSeconds } from "../format.ts";
import type { FrameData, VideoFrame } from "../fetch/types.ts";

/** ffmpeg is CPU-heavy; more than a few at once helps nobody. */
const FRAME_CONCURRENCY = 3;
const FRAME_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;

export interface FrameOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam replacing the ffmpeg invocation. */
  runner?: (seconds: number) => Promise<FrameData>;
}

/**
 * Grabs a single frame as JPEG bytes.
 *
 * `-ss` before `-i` seeks by keyframe, which is what makes this fast enough to
 * run against a remote stream URL rather than downloading the video.
 */
export async function extractFrame(
  source: string,
  seconds: number,
  options: FrameOptions = {},
): Promise<FrameData> {
  if (options.runner) return options.runner(seconds);

  try {
    const { stdout } = await run(
      "ffmpeg",
      [
        "-ss",
        String(seconds),
        "-i",
        source,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      {
        timeoutMs: options.timeoutMs ?? FRAME_TIMEOUT_MS,
        maxBuffer: MAX_FRAME_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (stdout.length === 0) {
      throw new GleanError("invalid-response", "ffmpeg produced no frame data", {
        source: "ffmpeg",
      });
    }
    return { data: stdout.toString("base64"), mimeType: "image/jpeg" };
  } catch (error) {
    throw mapFfmpegError(error);
  }
}

export interface ExtractFramesResult {
  frames: VideoFrame[];
  errors: string[];
}

/** Extracts several frames concurrently, keeping whichever succeed. */
export async function extractFrames(
  source: string,
  timestamps: number[],
  options: FrameOptions = {},
): Promise<ExtractFramesResult> {
  const limit = pLimit(FRAME_CONCURRENCY);
  const settled = await Promise.all(
    timestamps.map((seconds) =>
      limit(async () => {
        try {
          const frame = await extractFrame(source, seconds, options);
          return { ok: true as const, frame: { ...frame, timestamp: formatSeconds(seconds) } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false as const, error: `${formatSeconds(seconds)}: ${message}` };
        }
      }),
    ),
  );

  const frames: VideoFrame[] = [];
  const errors: string[] = [];
  for (const outcome of settled) {
    if (outcome.ok) frames.push(outcome.frame);
    else errors.push(outcome.error);
  }
  return { frames, errors };
}

export interface ProbeOptions {
  signal?: AbortSignal;
  runner?: () => Promise<string>;
}

/** Duration in seconds via ffprobe, or null when it cannot be determined. */
export async function probeDuration(
  source: string,
  options: ProbeOptions = {},
): Promise<number | null> {
  try {
    const stdout = options.runner
      ? await options.runner()
      : (
          await runText(
            "ffprobe",
            ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", source],
            { timeoutMs: PROBE_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) },
          )
        ).stdout;
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    // A missing ffprobe is worth reporting; anything else just means unknown.
    if (error instanceof GleanError && error.kind === "missing_binary") throw error;
    return null;
  }
}
