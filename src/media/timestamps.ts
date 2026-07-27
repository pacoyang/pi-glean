/**
 * Video timestamp parsing and frame scheduling.
 *
 * Lives under media/ rather than fetch/: these parse video positions
 * (`"1:23:45"`, ranges, frame intervals) and have nothing to do with the web.
 */

import { GleanError } from "../errors.ts";

export const DEFAULT_RANGE_FRAMES = 6;
/** Frames closer together than this show essentially the same picture. */
export const MIN_FRAME_INTERVAL = 5;

export type TimestampSpec =
  | { type: "single"; seconds: number }
  | { type: "range"; start: number; end: number };

/** Accepts `"1:23:45"`, `"23:45"` and bare `"85"` seconds. */
export function parseTimestamp(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null;

  if (numbers.length === 3) {
    const [h, m, s] = numbers as [number, number, number];
    return Math.floor(h * 3600 + m * 60 + s);
  }
  const [m, s] = numbers as [number, number];
  return Math.floor(m * 60 + s);
}

/**
 * Parses either a point or a `start-end` range.
 *
 * The separator search starts at index 1 so a leading minus is never mistaken
 * for one.
 */
export function parseTimestampSpec(input: string): TimestampSpec | null {
  const trimmed = input.trim();
  const dash = trimmed.indexOf("-", 1);
  if (dash > 0) {
    const start = parseTimestamp(trimmed.slice(0, dash));
    const end = parseTimestamp(trimmed.slice(dash + 1));
    if (start !== null && end !== null && end > start) return { type: "range", start, end };
    return null;
  }
  const seconds = parseTimestamp(trimmed);
  return seconds !== null ? { type: "single", seconds } : null;
}

/**
 * Spreads up to `maxFrames` evenly across a range.
 *
 * When even spacing would put frames closer than MIN_FRAME_INTERVAL, step by
 * that interval instead and return fewer frames: six near-identical stills are
 * worse than three distinct ones.
 */
export function computeRangeTimestamps(
  start: number,
  end: number,
  maxFrames = DEFAULT_RANGE_FRAMES,
): number[] {
  if (maxFrames <= 1) return [start];

  const idealInterval = (end - start) / (maxFrames - 1);
  if (idealInterval < MIN_FRAME_INTERVAL) {
    const timestamps: number[] = [];
    for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
      timestamps.push(t);
    }
    return timestamps.length > 0 ? timestamps : [start];
  }

  return Array.from({ length: maxFrames }, (_, index) => Math.round(start + index * idealInterval));
}

/** Evenly spaced sample points across a whole video, avoiding the very edges. */
export function sampleTimestamps(durationSeconds: number, frames: number): number[] {
  if (frames <= 1) return [Math.floor(durationSeconds / 2)];
  const step = durationSeconds / (frames + 1);
  return Array.from({ length: frames }, (_, index) => Math.round(step * (index + 1)));
}

export function withinDuration(timestamps: number[], durationSeconds: number | null): number[] {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) return timestamps;
  return timestamps.filter((seconds) => seconds < durationSeconds);
}

/**
 * Decides which frames to capture, from whatever the caller was given.
 *
 * Shared by the local-video and YouTube paths: the branching — an explicit
 * point, an explicit range, or an even sweep of the whole thing — is identical
 * either side, and only the label in the error differs.
 */
export function planTimestamps(
  timestamp: string | undefined,
  frames: number | undefined,
  durationSeconds: number | null,
  source: string,
): number[] {
  const requested = frames ?? DEFAULT_RANGE_FRAMES;

  if (timestamp) {
    const spec = parseTimestampSpec(timestamp);
    if (!spec) {
      throw new GleanError(
        "schema",
        `Could not parse timestamp "${timestamp}" — use 1:23:45, 23:45, 85, or a 1:23-2:30 range.`,
        { source },
      );
    }
    const planned =
      spec.type === "range"
        ? computeRangeTimestamps(spec.start, spec.end, requested)
        : [spec.seconds];
    return withinDuration(planned, durationSeconds);
  }

  // With no duration there is nothing to spread across; one opening frame at
  // least shows what the video is.
  if (durationSeconds === null) return [0];
  return withinDuration(sampleTimestamps(durationSeconds, requested), durationSeconds);
}
