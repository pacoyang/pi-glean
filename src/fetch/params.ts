/**
 * Normalizes `glean_fetch` arguments before anything touches the network.
 *
 * Models pass these loosely — a single `url`, an array, sometimes both — so the
 * shapes are reconciled here rather than in the pipeline.
 */

export interface RawFetchParams {
  url?: unknown;
  urls?: unknown;
  forceClone?: unknown;
  prompt?: unknown;
  timestamp?: unknown;
  frames?: unknown;
}

export interface NormalizedFetchParams {
  urlList: string[];
  options: {
    forceClone?: boolean;
    prompt?: string;
    timestamp?: string;
    frames?: number;
  };
}

function singleUrl(value: unknown): string[] {
  if (typeof value !== "string") return [];
  // Models sometimes prefix a path with @; strip it rather than 404.
  const trimmed = value.trim().replace(/^@/, "");
  return trimmed ? [trimmed] : [];
}

function urlArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(singleUrl) : [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

export function normalizeFetchParams(params: RawFetchParams): NormalizedFetchParams {
  const fromArray = [...new Set(urlArray(params.urls))];
  const urlList = fromArray.length > 0 ? fromArray : singleUrl(params.url);

  const prompt = optionalString(params.prompt);
  const timestamp = optionalString(params.timestamp);
  const frames = optionalInteger(params.frames);

  // `frames` alone means nothing at frames:1 — that is just the default single
  // grab. It only takes effect alongside a timestamp, or when asking for more
  // than one frame.
  const shouldIncludeFrames = frames !== undefined && (timestamp !== undefined || frames > 1);

  const forceClone = typeof params.forceClone === "boolean" ? params.forceClone : undefined;

  return {
    urlList,
    options: {
      ...(forceClone !== undefined ? { forceClone } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(shouldIncludeFrames ? { frames } : {}),
    },
  };
}
