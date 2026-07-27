import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeEntities,
  dedupeCues,
  overlapLength,
  parseTimecode,
  parseVtt,
  stripCueTags,
  toMarkdown,
  vttToMarkdown,
} from "../src/media/vtt.ts";
import {
  computeRangeTimestamps,
  parseTimestamp,
  parseTimestampSpec,
  sampleTimestamps,
  withinDuration,
} from "../src/media/timestamps.ts";

/**
 * A realistic YouTube auto-caption fragment: each cue repeats the previous line
 * and appends a few words, and the window rolls once it fills.
 */
const ROLLING_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.120 --> 00:00:02.500
so today we're going

00:00:02.500 --> 00:00:04.900
so today we're going to talk about

00:00:04.900 --> 00:00:07.100
to talk about React 19 and

00:00:07.100 --> 00:00:09.400
React 19 and the new compiler
`;

describe("rolling-caption deduplication", () => {
  it("collapses the repetition instead of concatenating it", () => {
    // This is the single assertion that matters most: naive concatenation makes
    // the transcript several times longer than the speech and unreadable.
    const segments = dedupeCues(parseVtt(ROLLING_VTT));
    const transcript = segments.map((segment) => segment.text).join(" ");
    assert.equal(transcript, "so today we're going to talk about React 19 and the new compiler");
  });

  it("keeps the transcript close to the length of the speech", () => {
    const naive = parseVtt(ROLLING_VTT)
      .map((cue) => cue.text)
      .join(" ");
    const deduped = dedupeCues(parseVtt(ROLLING_VTT))
      .map((segment) => segment.text)
      .join(" ");
    assert.ok(
      deduped.length < naive.length * 0.6,
      `deduped ${deduped.length} vs naive ${naive.length}`,
    );
  });

  it("drops a cue that adds nothing new", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
hello world

00:00:02.000 --> 00:00:04.000
hello world

00:00:04.000 --> 00:00:06.000
hello world again
`;
    const segments = dedupeCues(parseVtt(vtt));
    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["hello world", "again"],
    );
  });

  it("handles a window that has rolled past the start", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
one two three

00:00:02.000 --> 00:00:04.000
three four five
`;
    assert.equal(
      dedupeCues(parseVtt(vtt))
        .map((s) => s.text)
        .join(" "),
      "one two three four five",
    );
  });

  it("keeps timestamps attached to genuinely new speech", () => {
    const segments = dedupeCues(parseVtt(ROLLING_VTT));
    assert.equal(segments[0]?.start, 0.12);
    assert.equal(segments[1]?.start, 2.5);
    // Every emitted segment carries the time its new words were first spoken.
    for (const segment of segments) assert.ok(segment.text.length > 0);
  });

  it("matches case-insensitively, as caption casing drifts", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello World

00:00:02.000 --> 00:00:04.000
hello world again
`;
    assert.equal(
      dedupeCues(parseVtt(vtt))
        .map((s) => s.text)
        .join(" "),
      "Hello World again",
    );
  });

  it("leaves manual captions untouched when they do not repeat", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
First distinct sentence.

00:00:03.000 --> 00:00:06.000
Second distinct sentence.
`;
    assert.equal(
      dedupeCues(parseVtt(vtt))
        .map((s) => s.text)
        .join(" "),
      "First distinct sentence. Second distinct sentence.",
    );
  });
});

describe("overlapLength", () => {
  it("finds the longest overlap, not the first", () => {
    // A shorter match would leave part of the repetition behind.
    assert.equal(overlapLength(["a", "b", "c"], ["b", "c", "d"]), 2);
    assert.equal(overlapLength(["a", "b", "c"], ["c", "d"]), 1);
    assert.equal(overlapLength(["a", "b"], ["x", "y"]), 0);
  });

  it("handles complete containment", () => {
    assert.equal(overlapLength(["a", "b"], ["a", "b"]), 2);
  });

  it("is safe on empty input", () => {
    assert.equal(overlapLength([], ["a"]), 0);
    assert.equal(overlapLength(["a"], []), 0);
  });
});

describe("cue parsing", () => {
  it("strips karaoke timing and colour tags", () => {
    assert.equal(
      stripCueTags("<00:00:01.500><c>hello</c> <00:00:02.000><c>world</c>"),
      "hello world",
    );
  });

  it("decodes HTML entities", () => {
    assert.equal(decodeEntities("Tom &amp; Jerry&#39;s &quot;show&quot;"), `Tom & Jerry's "show"`);
    assert.equal(decodeEntities("a &lt;tag&gt; b"), "a <tag> b");
  });

  it("parses timecodes with and without hours", () => {
    assert.equal(parseTimecode("00:00:02.500"), 2.5);
    assert.equal(parseTimecode("01:02:03.000"), 3723);
    assert.equal(parseTimecode("02:03.500"), 123.5);
    assert.equal(parseTimecode("nope"), null);
  });

  it("ignores headers, NOTE and STYLE blocks", () => {
    const vtt = `WEBVTT
Kind: captions

NOTE this is a comment

STYLE
::cue { color: white }

00:00:00.000 --> 00:00:02.000
actual text
`;
    const cues = parseVtt(vtt);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.text, "actual text");
  });

  it("tolerates cue identifiers and positioning settings", () => {
    const vtt = `WEBVTT

cue-1
00:00:00.000 --> 00:00:02.000 align:start position:10%
positioned text
`;
    const cues = parseVtt(vtt);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.text, "positioned text");
    assert.equal(cues[0]?.end, 2);
  });

  it("accepts CRLF line endings", () => {
    const cues = parseVtt("WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nhi\r\n");
    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.text, "hi");
  });

  it("returns nothing for an empty or malformed file", () => {
    assert.deepEqual(parseVtt(""), []);
    assert.deepEqual(parseVtt("WEBVTT\n\nnot a cue\n"), []);
  });
});

describe("markdown output", () => {
  it("emits timestamped paragraphs", () => {
    const markdown = vttToMarkdown(ROLLING_VTT);
    assert.match(markdown, /^\*\*\[0:00]\*\* so today/);
    assert.match(markdown, /the new compiler/);
  });

  it("starts a new paragraph after a long gap", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
first part

00:01:00.000 --> 00:01:02.000
much later
`;
    const markdown = vttToMarkdown(vtt);
    assert.equal(markdown.split("\n\n").length, 2);
    assert.match(markdown, /\*\*\[1:00]\*\* much later/);
  });

  it("returns an empty string when there is nothing to show", () => {
    assert.equal(toMarkdown([]), "");
    assert.equal(vttToMarkdown("WEBVTT\n"), "");
  });
});

describe("timestamp parsing", () => {
  it("accepts all three input shapes", () => {
    assert.equal(parseTimestamp("1:23:45"), 5025);
    assert.equal(parseTimestamp("23:45"), 1425);
    assert.equal(parseTimestamp("85"), 85);
  });

  it("rejects nonsense", () => {
    for (const input of ["", "abc", "1:2:3:4", "-5", "1:-2"]) {
      assert.equal(parseTimestamp(input), null, input);
    }
  });

  it("distinguishes a range from a single point", () => {
    assert.deepEqual(parseTimestampSpec("1:23"), { type: "single", seconds: 83 });
    assert.deepEqual(parseTimestampSpec("1:23-2:30"), { type: "range", start: 83, end: 150 });
  });

  it("rejects a range that does not move forward", () => {
    assert.equal(parseTimestampSpec("2:30-1:23"), null);
    assert.equal(parseTimestampSpec("1:23-1:23"), null);
  });
});

describe("frame scheduling", () => {
  it("spreads frames evenly across a wide range", () => {
    assert.deepEqual(computeRangeTimestamps(0, 100, 6), [0, 20, 40, 60, 80, 100]);
  });

  it("never places frames closer than the minimum interval", () => {
    // Six stills from a ten-second window would be near-identical.
    const timestamps = computeRangeTimestamps(0, 10, 6);
    for (let i = 1; i < timestamps.length; i++) {
      assert.ok(timestamps[i]! - timestamps[i - 1]! >= 5, timestamps.join(","));
    }
    assert.ok(timestamps.length < 6, "fewer, distinct frames beat six identical ones");
  });

  it("returns a single frame when asked for one", () => {
    assert.deepEqual(computeRangeTimestamps(10, 100, 1), [10]);
  });

  it("samples a whole video without hitting the edges", () => {
    const samples = sampleTimestamps(100, 4);
    assert.equal(samples.length, 4);
    assert.ok(samples[0]! > 0);
    assert.ok(samples[samples.length - 1]! < 100);
  });

  it("drops frames beyond the duration", () => {
    assert.deepEqual(withinDuration([10, 50, 200], 100), [10, 50]);
    assert.deepEqual(
      withinDuration([10, 200], null),
      [10, 200],
      "unknown duration filters nothing",
    );
  });
});
