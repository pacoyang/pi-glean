import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseCaptionTrack,
  extractYouTube,
  parseProbeOutput,
  parseYouTubeUrl,
  pickSubtitleFile,
  probeArgs,
  streamUrlArgs,
  subtitleArgs,
} from "../src/media/youtube.ts";
import { GleanError } from "../src/errors.ts";
import type { FrameData } from "../src/fetch/types.ts";
import { testConfig } from "./helpers/fixtures.ts";

const ROLLING_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
so today we're going

00:00:02.000 --> 00:00:04.000
so today we're going to talk about React
`;

function jpeg(): FrameData {
  return { data: "///", mimeType: "image/jpeg" };
}

function probeLines(options: {
  title?: string | null;
  duration?: number | null;
  manual?: string[];
  auto?: string[];
}): string {
  const dict = (langs: string[] | undefined) =>
    langs === undefined
      ? "NA"
      : JSON.stringify(Object.fromEntries(langs.map((lang) => [lang, [{ ext: "vtt" }]])));
  return [
    JSON.stringify(options.title ?? "React 19 in 10 minutes"),
    options.duration === undefined ? "600" : JSON.stringify(options.duration),
    dict(options.manual),
    dict(options.auto),
  ].join("\n");
}

/** Routes yt-dlp invocations by which flags they carry. */
function ytDlpStub(handlers: {
  probe?: () => string;
  subtitles?: (args: string[]) => string;
  stream?: () => string;
}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("--print")) return handlers.probe?.() ?? probeLines({});
    if (args.includes("-g")) return handlers.stream?.() ?? "https://stream.example/v.mp4\n";
    return handlers.subtitles?.(args) ?? "";
  };
  return { run, calls };
}

describe("parseYouTubeUrl", () => {
  it("recognises every shape YouTube serves", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
    ]) {
      assert.equal(parseYouTubeUrl(url), "dQw4w9WgXcQ", url);
    }
  });

  it("declines anything that is not a single video", () => {
    for (const url of [
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/playlist?list=PL123",
      "https://vimeo.com/12345",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "not a url",
    ]) {
      assert.equal(parseYouTubeUrl(url), null, url);
    }
  });
});

describe("parseProbeOutput", () => {
  it("reads the four JSON lines", () => {
    const probe = parseProbeOutput(
      probeLines({ duration: 754, manual: ["en"], auto: ["en", "zh-Hans"] }),
    );
    assert.equal(probe.title, "React 19 in 10 minutes");
    assert.equal(probe.duration, 754);
    assert.deepEqual(probe.captions, { manual: ["en"], auto: ["en", "zh-Hans"] });
  });

  it("survives a title containing a newline", () => {
    // This is exactly why every field is JSON-encoded: a raw title would shift
    // the duration and caption lines and silently corrupt the probe.
    const probe = parseProbeOutput(probeLines({ title: "line one\nline two", manual: ["en"] }));
    assert.equal(probe.title, "line one\nline two");
    assert.equal(probe.duration, 600);
    assert.deepEqual(probe.captions?.manual, ["en"]);
  });

  it("treats NA and null as unknown rather than as data", () => {
    const probe = parseProbeOutput(['"t"', "null", "NA", "NA"].join("\n"));
    assert.equal(probe.duration, null);
    assert.equal(probe.captions, null, "unknown availability must not read as 'no captions'");
  });

  it("distinguishes 'no captions' from 'could not tell'", () => {
    const none = parseProbeOutput(probeLines({ manual: [], auto: [] }));
    assert.deepEqual(none.captions, { manual: [], auto: [] });
  });
});

describe("chooseCaptionTrack", () => {
  const available = { manual: ["en", "fr"], auto: ["en", "es"] };

  it("prefers auto-generated captions by default", () => {
    assert.deepEqual(chooseCaptionTrack(available, ["en"], true), { lang: "en", auto: true });
  });

  it("prefers manual captions when asked to", () => {
    assert.deepEqual(chooseCaptionTrack(available, ["en"], false), { lang: "en", auto: false });
  });

  it("falls back to the other list when the preferred one lacks the language", () => {
    assert.deepEqual(chooseCaptionTrack(available, ["fr"], true), { lang: "fr", auto: false });
    assert.deepEqual(chooseCaptionTrack(available, ["es"], false), { lang: "es", auto: true });
  });

  it("matches regional variants in both directions", () => {
    assert.deepEqual(chooseCaptionTrack({ manual: [], auto: ["en-US"] }, ["en"], true), {
      lang: "en-US",
      auto: true,
    });
    assert.deepEqual(chooseCaptionTrack({ manual: [], auto: ["en"] }, ["en-GB"], true), {
      lang: "en",
      auto: true,
    });
  });

  it("takes whatever the video has when no configured language matches", () => {
    // A Chinese video under the default subtitleLangs: ["en"] must still be
    // transcribed rather than reported as having no captions.
    assert.deepEqual(chooseCaptionTrack({ manual: [], auto: ["zh-Hans"] }, ["en"], true), {
      lang: "zh-Hans",
      auto: true,
    });
  });

  it("honours the configured language order", () => {
    assert.deepEqual(chooseCaptionTrack({ manual: ["de", "ja"], auto: [] }, ["ja", "de"], true), {
      lang: "ja",
      auto: false,
    });
  });

  it("returns null when there is genuinely nothing", () => {
    assert.equal(chooseCaptionTrack({ manual: [], auto: [] }, ["en"], true), null);
  });
});

describe("pickSubtitleFile", () => {
  it("prefers the exact language", () => {
    assert.equal(pickSubtitleFile(["sub.es.vtt", "sub.en.vtt"], "en"), "sub.en.vtt");
  });

  it("accepts a regional variant of the requested language", () => {
    assert.equal(pickSubtitleFile(["sub.en-US.vtt"], "en"), "sub.en-US.vtt");
  });

  it("ignores non-subtitle leftovers", () => {
    assert.equal(pickSubtitleFile(["sub.en.vtt", "sub.mp4", "sub.info.json"], "en"), "sub.en.vtt");
    assert.equal(pickSubtitleFile(["sub.mp4"], "en"), null);
  });
});

describe("command construction", () => {
  it("JSON-encodes every probed field", () => {
    const args = probeArgs("https://youtu.be/abc", []);
    for (const field of ["%(title)j", "%(duration)j", "%(subtitles)j", "%(automatic_captions)j"]) {
      assert.ok(args.includes(field), field);
    }
    assert.ok(args.includes("--skip-download"));
    assert.equal(args.at(-1), "https://youtu.be/abc");
  });

  it("asks for exactly the chosen track", () => {
    const auto = subtitleArgs("u", { lang: "zh-Hans", auto: true }, ["en"], "/tmp/x/sub", []);
    assert.ok(auto.includes("--write-auto-sub"));
    assert.ok(!auto.includes("--write-sub"));
    assert.equal(auto[auto.indexOf("--sub-langs") + 1], "zh-Hans");

    const manual = subtitleArgs("u", { lang: "en", auto: false }, ["en"], "/tmp/x/sub", []);
    assert.ok(manual.includes("--write-sub"));
    assert.ok(!manual.includes("--write-auto-sub"));
  });

  it("falls back to wildcards when availability is unknown", () => {
    const args = subtitleArgs("u", null, ["en", "zh"], "/tmp/x/sub", []);
    assert.equal(args[args.indexOf("--sub-langs") + 1], "en,en.*,zh,zh.*");
    assert.ok(args.includes("--write-sub") && args.includes("--write-auto-sub"));
  });

  it("passes user-supplied yt-dlp flags through on every call", () => {
    const extra = ["--cookies-from-browser", "firefox"];
    for (const args of [
      probeArgs("u", extra),
      subtitleArgs("u", null, ["en"], "/tmp/x", extra),
      streamUrlArgs("u", extra),
    ]) {
      assert.ok(args.includes("--cookies-from-browser"), args.join(" "));
    }
  });
});

describe("extractYouTube", () => {
  const config = testConfig();

  it("returns null for anything that is not a YouTube video", async () => {
    assert.equal(await extractYouTube("https://example.com/x", { config }), null);
  });

  it("returns null when YouTube handling is switched off, so the page is still fetched", async () => {
    const off = testConfig({ youtube: { ...config.youtube, enabled: false } });
    assert.equal(await extractYouTube("https://youtu.be/abc123", { config: off }), null);
  });

  it("produces a deduplicated transcript", async () => {
    const { run, calls } = ytDlpStub({
      probe: () => probeLines({ duration: 754, manual: [], auto: ["en"] }),
    });
    const result = await extractYouTube("https://youtu.be/abc123", {
      config,
      ytDlp: run,
      listFiles: async () => ["sub.en.vtt"],
      readFile: async () => ROLLING_VTT,
    });

    assert.ok(result);
    assert.equal(result.error, null);
    assert.equal(result.via, "youtube-transcript");
    assert.equal(result.duration, 754);
    assert.match(result.content, /React 19 in 10 minutes/);
    assert.match(result.content, /\*\*Captions:\*\* en \(auto-generated\)/);
    // The rolling repetition is collapsed, not concatenated.
    assert.match(result.content, /so today we're going to talk about React/);
    assert.equal(result.content.match(/so today/g)?.length, 1);
    assert.equal(calls.length, 2, "one probe, one subtitle download");
  });

  it("says so plainly when the video has no captions at all", async () => {
    const { run } = ytDlpStub({ probe: () => probeLines({ manual: [], auto: [] }) });
    const result = await extractYouTube("https://youtu.be/abc123", { config, ytDlp: run });

    assert.ok(result);
    assert.match(result.error!, /no caption track/);
    assert.match(result.error!, /GEMINI_API_KEY/, "the error names the way forward");
    assert.match(result.error!, /timestamp/);
  });

  it("has Gemini watch the video when captions are missing and a key is set", async () => {
    const { run } = ytDlpStub({ probe: () => probeLines({ manual: [], auto: [] }) });
    const result = await extractYouTube("https://youtu.be/abc123", {
      config,
      ytDlp: run,
      analyze: async () => "It is a talk about React 19.",
    });

    assert.ok(result);
    assert.equal(result.error, null);
    assert.equal(result.via, "youtube-gemini");
    assert.match(result.content, /talk about React 19/);
  });

  it("answers a question with Gemini rather than dumping the transcript", async () => {
    const { run, calls } = ytDlpStub({
      probe: () => probeLines({ duration: 754, manual: [], auto: ["en"] }),
    });
    const prompts: string[] = [];
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      {
        config,
        ytDlp: run,
        analyze: async (_url, prompt) => {
          prompts.push(prompt);
          return "It explains the compiler.";
        },
      },
      { prompt: "What does it say about the compiler?" },
    );

    assert.ok(result);
    assert.equal(result.via, "youtube-gemini");
    assert.deepEqual(prompts, ["What does it say about the compiler?"]);
    assert.equal(calls.length, 1, "no subtitle download was needed");
  });

  it("falls back to the transcript when Gemini fails", async () => {
    const { run } = ytDlpStub({
      probe: () => probeLines({ duration: 754, manual: [], auto: ["en"] }),
    });
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      {
        config,
        ytDlp: run,
        listFiles: async () => ["sub.en.vtt"],
        readFile: async () => ROLLING_VTT,
        analyze: async () => {
          throw new GleanError("quota", "out of quota");
        },
      },
      { prompt: "summarize" },
    );

    assert.ok(result);
    assert.equal(result.via, "youtube-transcript");
    assert.equal(result.error, null);
  });

  it("captures frames across a requested range", async () => {
    const { run, calls } = ytDlpStub({
      probe: () => probeLines({ duration: 3600, auto: ["en"] }),
    });
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      { config, ytDlp: run, frameRunner: async () => jpeg() },
      { timestamp: "1:00-2:00", frames: 3 },
    );

    assert.ok(result);
    assert.equal(result.via, "youtube-frames");
    assert.deepEqual(
      result.frames?.map((frame) => frame.timestamp),
      ["1:00", "1:30", "2:00"],
    );
    assert.ok(
      calls.some((args) => args.includes("-g")),
      "never resolved a stream URL",
    );
  });

  it("samples across the whole video when only a frame count is given", async () => {
    const { run } = ytDlpStub({ probe: () => probeLines({ duration: 100, auto: ["en"] }) });
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      { config, ytDlp: run, frameRunner: async () => jpeg() },
      { frames: 3 },
    );

    assert.ok(result);
    assert.equal(result.frames?.length, 3);
  });

  it("rejects an unparseable timestamp before spending a subprocess on it", async () => {
    const { run } = ytDlpStub({ probe: () => probeLines({ duration: 100, auto: ["en"] }) });
    await assert.rejects(
      () =>
        extractYouTube(
          "https://youtu.be/abc123",
          { config, ytDlp: run, frameRunner: async () => jpeg() },
          { timestamp: "half past three" },
        ),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "schema");
        return true;
      },
    );
  });

  it("reports a missing yt-dlp with its install hint", async () => {
    const run = async (): Promise<string> => {
      throw new GleanError("missing_binary", "yt-dlp is not installed or not on PATH");
    };
    const result = await extractYouTube("https://youtu.be/abc123", { config, ytDlp: run });

    assert.ok(result);
    assert.match(result.error!, /not installed/);
    assert.match(result.error!, /GEMINI_API_KEY/);
  });

  it("still answers via Gemini when yt-dlp is missing entirely", async () => {
    const run = async (): Promise<string> => {
      throw new GleanError("missing_binary", "yt-dlp is not installed or not on PATH");
    };
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      { config, ytDlp: run, analyze: async () => "A talk about React." },
      { prompt: "what is it" },
    );

    assert.ok(result);
    assert.equal(result.error, null);
    assert.equal(result.via, "youtube-gemini");
  });

  it("cannot substitute Gemini for frames, and says why", async () => {
    const run = async (): Promise<string> => {
      throw new GleanError("missing_binary", "yt-dlp is not installed or not on PATH");
    };
    const result = await extractYouTube(
      "https://youtu.be/abc123",
      { config, ytDlp: run, analyze: async () => "unused" },
      { timestamp: "1:23" },
    );

    assert.ok(result);
    assert.match(result.error!, /not installed/);
  });
});
