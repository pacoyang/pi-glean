/**
 * WebVTT → timestamped markdown.
 *
 * The hard part is YouTube's auto-generated captions. They are a *rolling
 * window*: each cue repeats what the previous one said and appends a few new
 * words, so naive concatenation produces a transcript three to five times
 * longer than the speech, with every phrase repeated.
 *
 *   00:00:00.000 --> 00:00:02.000   hello
 *   00:00:02.000 --> 00:00:04.000   hello world
 *   00:00:04.000 --> 00:00:06.000   world this is
 *
 * Correct output is "hello world this is", not the concatenation. Deduplication
 * works on words: find the longest suffix of what has been emitted that matches
 * a prefix of the incoming cue, and append only the remainder. That handles
 * both the growing case and the case where the window has already rolled past
 * the start.
 */

import { formatSeconds } from "../format.ts";

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

/** How far back to look for an overlap; bounds the cost on long transcripts. */
const MAX_OVERLAP_WORDS = 60;
/** Group cues into paragraphs at roughly this spacing. */
const PARAGRAPH_SECONDS = 30;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Strips karaoke timing tags, `<c>` colour spans and positioning metadata. */
export function stripCueTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTimecode(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, "0")) / 1000 : 0)
  );
}

export function parseVtt(source: string): VttCue[] {
  const cues: VttCue[] = [];
  // Blocks are separated by blank lines; the WEBVTT header and NOTE/STYLE
  // blocks have no timing line and fall out naturally.
  for (const block of source.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const [rawStart, rawRest] = lines[timingIndex]!.split("-->");
    if (!rawStart || !rawRest) continue;
    const start = parseTimecode(rawStart);
    // Trailing positioning settings live on the same line as the end time.
    const end = parseTimecode(rawRest.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;

    const text = stripCueTags(lines.slice(timingIndex + 1).join(" "));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Longest k where the last k words of `previous` equal the first k of `next`.
 *
 * The longest match is the right choice for rolling captions: a shorter one
 * would leave a partial repetition behind.
 */
export function overlapLength(previous: string[], next: string[]): number {
  const max = Math.min(previous.length, next.length, MAX_OVERLAP_WORDS);
  for (let k = max; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (previous[previous.length - k + i]!.toLowerCase() !== next[i]!.toLowerCase()) {
        matches = false;
        break;
      }
    }
    if (matches) return k;
  }
  return 0;
}

export interface DedupedSegment {
  start: number;
  text: string;
}

/**
 * Collapses rolling repetition into a linear transcript.
 *
 * A cue that adds nothing new is dropped entirely rather than emitted with an
 * empty body, so timestamps stay attached to actual new speech.
 */
export function dedupeCues(cues: VttCue[]): DedupedSegment[] {
  const segments: DedupedSegment[] = [];
  let emitted: string[] = [];

  for (const cue of cues) {
    const incoming = words(cue.text);
    if (incoming.length === 0) continue;

    const overlap = overlapLength(emitted, incoming);
    const fresh = incoming.slice(overlap);
    if (fresh.length === 0) continue;

    segments.push({ start: cue.start, text: fresh.join(" ") });
    emitted = emitted.concat(fresh).slice(-MAX_OVERLAP_WORDS);
  }

  return segments;
}

/** Groups segments into timestamped paragraphs. */
export function toMarkdown(segments: DedupedSegment[]): string {
  if (segments.length === 0) return "";

  const paragraphs: string[] = [];
  let blockStart = segments[0]!.start;
  let block: string[] = [];

  const flush = (): void => {
    if (block.length === 0) return;
    paragraphs.push(`**[${formatSeconds(blockStart)}]** ${block.join(" ")}`);
    block = [];
  };

  for (const segment of segments) {
    if (block.length > 0 && segment.start - blockStart >= PARAGRAPH_SECONDS) {
      flush();
      blockStart = segment.start;
    }
    if (block.length === 0) blockStart = segment.start;
    block.push(segment.text);
  }
  flush();

  return paragraphs.join("\n\n");
}

/** Full pipeline: raw VTT to a readable, deduplicated transcript. */
export function vttToMarkdown(source: string): string {
  return toMarkdown(dedupeCues(parseVtt(source)));
}
