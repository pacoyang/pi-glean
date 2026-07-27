/**
 * YouTube → transcript, frames, or an answer about the video.
 *
 * Subtitles come first and are the default path: yt-dlp fetches the caption
 * track, {@link vttToMarkdown} collapses YouTube's rolling auto-caption
 * repetition, and the result is a readable timestamped transcript. No API key,
 * no upload, no browser.
 *
 * Gemini is an optional upgrade, not the primary route (upstream had it the
 * other way round): it answers a question about the video, and it stands in
 * when no caption track exists at all.
 *
 * Availability is probed in one call up front rather than guessed from what
 * lands on disk, so the language fallback — configured languages, then their
 * regional variants, then whatever the video actually has — is a pure decision
 * we can test without a network.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import { GleanError } from "../errors.ts";
import { mapYtDlpError, runText } from "../exec.ts";
import { formatSeconds } from "../format.ts";
import { scratchDir } from "../config.ts";
import type { ExtractedContent, ExtractOptions } from "../fetch/types.ts";
import { extractFrames, type FrameOptions } from "./frames.ts";
import { planTimestamps } from "./timestamps.ts";
import { vttToMarkdown } from "./vtt.ts";

const PROBE_TIMEOUT_MS = 60_000;
const SUBTITLE_TIMEOUT_MS = 120_000;
const STREAM_URL_TIMEOUT_MS = 60_000;
/** A video's auto-caption listing covers ~200 translated languages. */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const ID_PATTERN = /^[\w-]{6,}$/;

/** Returns the video id, or null when this is not a YouTube video URL. */
export function parseYouTubeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;

  if (parsed.hostname.toLowerCase().endsWith("youtu.be")) {
    const id = parsed.pathname.slice(1).split("/")[0] ?? "";
    return ID_PATTERN.test(id) ? id : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "watch") {
    const id = parsed.searchParams.get("v") ?? "";
    return ID_PATTERN.test(id) ? id : null;
  }
  if (segments.length >= 2 && ["shorts", "embed", "live", "v"].includes(segments[0]!)) {
    const id = segments[1]!;
    return ID_PATTERN.test(id) ? id : null;
  }
  return null;
}

export interface CaptionAvailability {
  manual: string[];
  auto: string[];
}

export interface VideoProbe {
  title: string | null;
  duration: number | null;
  /** Null when yt-dlp's listing could not be parsed — callers then guess. */
  captions: CaptionAvailability | null;
}

function parseJsonLine(line: string | undefined): unknown {
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  // yt-dlp prints a bare NA for fields it cannot resolve, which is not JSON.
  if (!trimmed || trimmed === "NA") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function languageKeys(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value as Record<string, unknown>);
}

/** Parses the four JSON lines the probe command prints. */
export function parseProbeOutput(stdout: string): VideoProbe {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

  const title = parseJsonLine(lines[0]);
  const duration = parseJsonLine(lines[1]);
  const manual = languageKeys(parseJsonLine(lines[2]));
  const auto = languageKeys(parseJsonLine(lines[3]));

  return {
    title: typeof title === "string" && title ? title : null,
    duration: typeof duration === "number" && duration > 0 ? duration : null,
    captions: manual === null && auto === null ? null : { manual: manual ?? [], auto: auto ?? [] },
  };
}

export interface CaptionTrack {
  lang: string;
  auto: boolean;
}

function matchLanguage(available: string[], wanted: string): string | null {
  const lower = wanted.toLowerCase();
  const exact = available.find((lang) => lang.toLowerCase() === lower);
  if (exact) return exact;
  // `en` should find `en-US`, and `en-US` should settle for `en`.
  const base = lower.split("-")[0]!;
  return available.find((lang) => lang.toLowerCase().split("-")[0] === base) ?? null;
}

/**
 * Picks a caption track.
 *
 * `preferAutoSubs` decides only which of the two lists is consulted first for a
 * given language. Auto-generated captions are the default because they always
 * cover everything spoken, whereas a manual track is often a partial or
 * translated one — the cost is the rolling repetition, which vtt.ts undoes.
 *
 * Anything the configured languages do not match falls back to whatever the
 * video actually has, so a Chinese video is still transcribed under the default
 * `subtitleLangs: ["en"]`.
 */
export function chooseCaptionTrack(
  available: CaptionAvailability,
  languages: string[],
  preferAutoSubs: boolean,
): CaptionTrack | null {
  const order: Array<[string[], boolean]> = preferAutoSubs
    ? [
        [available.auto, true],
        [available.manual, false],
      ]
    : [
        [available.manual, false],
        [available.auto, true],
      ];

  for (const wanted of languages) {
    for (const [list, auto] of order) {
      const lang = matchLanguage(list, wanted);
      if (lang) return { lang, auto };
    }
  }

  for (const [list, auto] of order) {
    if (list.length > 0) return { lang: list[0]!, auto };
  }
  return null;
}

/** Picks the caption file yt-dlp actually wrote, preferring the exact language. */
export function pickSubtitleFile(files: string[], lang: string): string | null {
  const vtt = files.filter((name) => name.toLowerCase().endsWith(".vtt"));
  if (vtt.length === 0) return null;
  const lower = lang.toLowerCase();
  return (
    vtt.find((name) => name.toLowerCase().endsWith(`.${lower}.vtt`)) ??
    vtt.find((name) => name.toLowerCase().includes(`.${lower.split("-")[0]}`)) ??
    vtt[0]!
  );
}

export function probeArgs(url: string, extraArgs: string[]): string[] {
  // Every field is JSON-encoded so a title containing a newline cannot shift
  // the lines that follow it.
  return [
    "--skip-download",
    "--no-playlist",
    "--print",
    "%(title)j",
    "--print",
    "%(duration)j",
    "--print",
    "%(subtitles)j",
    "--print",
    "%(automatic_captions)j",
    ...extraArgs,
    url,
  ];
}

export function subtitleArgs(
  url: string,
  track: CaptionTrack | null,
  languages: string[],
  outputBase: string,
  extraArgs: string[],
): string[] {
  // With no probe result to go on, ask for the configured languages and their
  // regional variants and take whatever arrives.
  const langs = track ? track.lang : languages.flatMap((lang) => [lang, `${lang}.*`]).join(",");
  const writeFlag = track && !track.auto ? "--write-sub" : "--write-auto-sub";
  return [
    "--skip-download",
    "--no-playlist",
    writeFlag,
    ...(track ? [] : ["--write-sub"]),
    "--sub-langs",
    langs,
    "--sub-format",
    "vtt/best",
    "--convert-subs",
    "vtt",
    "--output",
    outputBase,
    ...extraArgs,
    url,
  ];
}

export function streamUrlArgs(url: string, extraArgs: string[]): string[] {
  return [
    "--no-playlist",
    "-f",
    "best[height<=720][ext=mp4]/best[height<=720]/best",
    "-g",
    ...extraArgs,
    url,
  ];
}

export interface YouTubeDeps {
  config: ResolvedConfig;
  signal?: AbortSignal;
  /** Test seam: runs yt-dlp and returns stdout. */
  ytDlp?: (args: string[], options: { timeoutMs: number; maxBuffer?: number }) => Promise<string>;
  /** Test seam: lists the files yt-dlp wrote. */
  listFiles?: (dir: string) => Promise<string[]>;
  /** Test seam: reads one of those files. */
  readFile?: (path: string) => Promise<string>;
  /** Test seam for ffmpeg, forwarded to {@link extractFrames}. */
  frameRunner?: FrameOptions["runner"];
  /** Test seam replacing the Gemini call. */
  analyze?: (url: string, prompt: string) => Promise<string>;
}

async function ytDlp(
  deps: YouTubeDeps,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number },
): Promise<string> {
  if (deps.ytDlp) return deps.ytDlp(args, options);
  try {
    const { stdout } = await runText("yt-dlp", args, {
      timeoutMs: options.timeoutMs,
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return stdout;
  } catch (error) {
    throw mapYtDlpError(error);
  }
}

async function geminiFor(deps: YouTubeDeps, url: string, prompt: string): Promise<string | null> {
  if (deps.analyze) return deps.analyze(url, prompt);
  if (!deps.config.youtube.gemini.enabled) return null;

  const { resolveCredential } = await import("../credentials.ts");
  const apiKey = await resolveCredential({
    provider: "gemini",
    configuredValue: deps.config.gemini.apiKey,
    environmentValue: process.env.GEMINI_API_KEY,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!apiKey) return null;

  const { analyzeYouTube } = await import("./gemini.ts");
  return analyzeYouTube(url, prompt, {
    apiKey,
    model: deps.config.video.preferredModel,
    ...(deps.config.gemini.baseUrl ? { baseUrl: deps.config.gemini.baseUrl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

function header(title: string, url: string, probe: VideoProbe, extra: string[]): string {
  const facts = [`**Source:** ${url}`];
  if (probe.duration) facts.push(`**Duration:** ${formatSeconds(probe.duration)}`);
  facts.push(...extra);
  return `# ${title}\n\n${facts.join(" · ")}\n`;
}

async function fetchTranscript(
  url: string,
  probe: VideoProbe,
  deps: YouTubeDeps,
): Promise<{ markdown: string; track: CaptionTrack | null } | null> {
  const { youtube } = deps.config;
  const track = probe.captions
    ? chooseCaptionTrack(probe.captions, youtube.subtitleLangs, youtube.preferAutoSubs)
    : null;
  // A parsed listing with no tracks at all is a definite "no captions"; an
  // unparseable one still deserves an attempt.
  if (probe.captions && !track) return null;

  const root = scratchDir("youtube");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "yt-"));

  try {
    await ytDlp(
      deps,
      subtitleArgs(url, track, youtube.subtitleLangs, join(dir, "sub"), youtube.ytDlpArgs),
      { timeoutMs: SUBTITLE_TIMEOUT_MS },
    );

    const files = await (deps.listFiles ?? ((target: string) => readdir(target)))(dir);
    const chosen = pickSubtitleFile(files, track?.lang ?? youtube.subtitleLangs[0] ?? "en");
    if (!chosen) return null;

    const vtt = await (deps.readFile ?? ((path: string) => readFile(path, "utf-8")))(
      join(dir, chosen),
    );
    const markdown = vttToMarkdown(vtt);
    return markdown ? { markdown, track } : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractYouTubeFrames(
  url: string,
  probe: VideoProbe,
  deps: YouTubeDeps,
  options: ExtractOptions,
): Promise<ExtractedContent> {
  const title = probe.title ?? "YouTube video";
  const timestamps = planTimestamps(options.timestamp, options.frames, probe.duration, "youtube");
  if (timestamps.length === 0) {
    throw new GleanError("invalid-request", "The requested timestamps fall outside the video.", {
      source: "youtube",
    });
  }

  const stdout = await ytDlp(deps, streamUrlArgs(url, deps.config.youtube.ytDlpArgs), {
    timeoutMs: STREAM_URL_TIMEOUT_MS,
  });
  const streamUrl = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!streamUrl) {
    throw new GleanError("invalid-response", "yt-dlp did not return a playable stream URL.", {
      source: "youtube",
    });
  }

  const { frames, errors } = await extractFrames(streamUrl, timestamps, {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.frameRunner ? { runner: deps.frameRunner } : {}),
  });

  const notes =
    errors.length > 0 ? `\n\nSome frames could not be captured:\n- ${errors.join("\n- ")}` : "";
  const content =
    header(title, url, probe, [`**Frames:** ${frames.length}`]) +
    `\nFrames at ${timestamps.map(formatSeconds).join(", ")}.${notes}`;

  return {
    url,
    title,
    content,
    error: null,
    via: "youtube-frames",
    frames,
    ...(probe.duration ? { duration: probe.duration } : {}),
  };
}

/**
 * Reads a YouTube video.
 *
 * Returns null when the URL is not a YouTube video or the feature is disabled,
 * so the caller falls through to the ordinary HTTP path.
 */
export async function extractYouTube(
  url: string,
  deps: YouTubeDeps,
  options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
  if (!deps.config.youtube.enabled) return null;
  if (!parseYouTubeUrl(url)) return null;

  const wantsFrames = options.frames !== undefined || options.timestamp !== undefined;

  let probe: VideoProbe = { title: null, duration: null, captions: null };
  let probeError: GleanError | null = null;
  try {
    probe = parseProbeOutput(
      await ytDlp(deps, probeArgs(url, deps.config.youtube.ytDlpArgs), {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
      }),
    );
  } catch (error) {
    probeError = error instanceof GleanError ? error : null;
    if (!probeError) throw error;
  }

  const title = probe.title ?? "YouTube video";

  if (wantsFrames) {
    // Frames need yt-dlp for the stream URL; there is no Gemini substitute.
    if (probeError) return { url, title, content: "", error: probeError.displayMessage };
    return extractYouTubeFrames(url, probe, deps, options);
  }

  if (!probeError) {
    // A question about the video is exactly what whole-video understanding is
    // for — when it is configured, prefer it over reading captions.
    if (options.prompt) {
      try {
        const answer = await geminiFor(deps, url, options.prompt);
        if (answer) {
          return {
            url,
            title,
            content: `${header(title, url, probe, ["**Analyzed by:** Gemini"])}\n${answer}`,
            error: null,
            via: "youtube-gemini",
            ...(probe.duration ? { duration: probe.duration } : {}),
          };
        }
      } catch {
        // Fall through to captions: a transcript still answers most questions.
      }
    }

    const transcript = await fetchTranscript(url, probe, deps);
    if (transcript) {
      const kind = transcript.track
        ? `${transcript.track.lang}${transcript.track.auto ? " (auto-generated)" : ""}`
        : "auto-detected";
      return {
        url,
        title,
        content: `${header(title, url, probe, [`**Captions:** ${kind}`])}\n${transcript.markdown}`,
        error: null,
        via: "youtube-transcript",
        ...(probe.duration ? { duration: probe.duration } : {}),
      };
    }
  }

  // No captions, or yt-dlp is unavailable. Gemini can still watch the video.
  try {
    const answer = await geminiFor(
      deps,
      url,
      options.prompt ?? "Transcribe this video, then summarize what it covers.",
    );
    if (answer) {
      return {
        url,
        title,
        content: `${header(title, url, probe, ["**Analyzed by:** Gemini"])}\n${answer}`,
        error: null,
        via: "youtube-gemini",
        ...(probe.duration ? { duration: probe.duration } : {}),
      };
    }
  } catch (error) {
    if (error instanceof GleanError && probeError) {
      return { url, title, content: "", error: probeError.displayMessage };
    }
  }

  const reason = probeError
    ? probeError.displayMessage
    : "This video has no caption track available.";
  return {
    url,
    title,
    content: "",
    error:
      `${reason}\n\nSet GEMINI_API_KEY to have the video watched directly, ` +
      `or pass a timestamp to capture frames with ffmpeg instead.`,
  };
}
