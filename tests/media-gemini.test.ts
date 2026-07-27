import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import { analyzeLocalVideo, analyzeYouTube } from "../src/media/gemini.ts";
import { fakeFetch, jsonResponse, type RecordedRequest } from "./helpers/fixtures.ts";

const API_KEY = "test-gemini-key";
let videoPath: string;
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "glean-gemini-"));
  videoPath = join(dir, "demo.mp4");
  await writeFile(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function uploadStart(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "x-goog-upload-url": "https://upload.example/session/1" },
  });
}

/** Full happy path: start → bytes → (poll) → generate → delete. */
function transport(options: { states?: string[]; answer?: string } = {}) {
  const states = options.states ?? ["ACTIVE"];
  let polls = 0;
  return fakeFetch((request: RecordedRequest) => {
    if (request.url.includes("/upload/v1beta/files")) return uploadStart();
    if (request.url.startsWith("https://upload.example/")) {
      return jsonResponse({
        file: {
          name: "files/abc",
          uri: "https://files.example/abc",
          mimeType: "video/mp4",
          state: states[0],
        },
      });
    }
    if (request.method === "DELETE") return jsonResponse({});
    if (request.url.includes(":generateContent")) {
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: options.answer ?? "A cat sits on a mat." }] } }],
      });
    }
    // Remaining GETs are status polls.
    polls++;
    return jsonResponse({
      name: "files/abc",
      uri: "https://files.example/abc",
      mimeType: "video/mp4",
      state: states[Math.min(polls, states.length - 1)],
    });
  });
}

describe("analyzeLocalVideo", () => {
  it("uploads, queries, and returns the answer", async () => {
    const { fetch: fetchImpl, requests } = transport();
    const answer = await analyzeLocalVideo(videoPath, "What happens?", {
      apiKey: API_KEY,
      model: "gemini-3-flash-preview",
      fetchImpl,
    });

    assert.equal(answer, "A cat sits on a mat.");

    const start = requests[0]!;
    assert.match(start.url, /\/upload\/v1beta\/files/);
    assert.equal(start.headers["x-goog-upload-protocol"], "resumable");
    assert.equal(start.headers["x-goog-upload-header-content-type"], "video/mp4");

    const generate = requests.find((request) => request.url.includes(":generateContent"))!;
    assert.match(generate.url, /models\/gemini-3-flash-preview:generateContent/);
    const parts = (generate.body as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts;
    assert.deepEqual(parts[0], { text: "What happens?" });
    assert.deepEqual(parts[1], {
      file_data: { mime_type: "video/mp4", file_uri: "https://files.example/abc" },
    });
  });

  it("waits for server-side processing before querying", async () => {
    const { fetch: fetchImpl, requests } = transport({ states: ["PROCESSING", "ACTIVE"] });
    await analyzeLocalVideo(videoPath, "?", {
      apiKey: API_KEY,
      model: "m",
      fetchImpl,
      pollIntervalMs: 1,
    });

    const order = requests.map((request) => request.url);
    const polled = order.findIndex((url) => /\/v1beta\/files\/abc\?/.test(url));
    const generated = order.findIndex((url) => url.includes(":generateContent"));
    assert.ok(polled >= 0, "never polled for readiness");
    assert.ok(polled < generated, "queried the file before it was ACTIVE");
  });

  it("deletes the upload even when the query fails", async () => {
    // A dangling upload counts against the account's storage forever.
    const { fetch: fetchImpl, requests } = fakeFetch((request) => {
      if (request.url.includes("/upload/v1beta/files")) return uploadStart();
      if (request.url.startsWith("https://upload.example/")) {
        return jsonResponse({
          file: { name: "files/abc", uri: "u", mimeType: "video/mp4", state: "ACTIVE" },
        });
      }
      if (request.method === "DELETE") return jsonResponse({});
      return jsonResponse({ error: { message: "boom" } }, 500);
    });

    await assert.rejects(
      () => analyzeLocalVideo(videoPath, "?", { apiKey: API_KEY, model: "m", fetchImpl }),
      /generateContent failed/,
    );
    assert.ok(
      requests.some((request) => request.method === "DELETE"),
      "the uploaded file was left behind",
    );
  });

  it("reports a processing failure rather than polling to the timeout", async () => {
    const { fetch: fetchImpl } = fakeFetch((request) => {
      if (request.url.includes("/upload/v1beta/files")) return uploadStart();
      if (request.url.startsWith("https://upload.example/")) {
        return jsonResponse({
          file: {
            name: "files/abc",
            uri: "u",
            state: "FAILED",
            error: { message: "unsupported codec" },
          },
        });
      }
      return jsonResponse({});
    });

    await assert.rejects(
      () => analyzeLocalVideo(videoPath, "?", { apiKey: API_KEY, model: "m", fetchImpl }),
      /unsupported codec/,
    );
  });

  it("classifies a 429 as quota and keeps the key out of the message", async () => {
    const { fetch: fetchImpl } = fakeFetch(
      () => new Response(`quota exceeded for key ${API_KEY}`, { status: 429 }),
    );

    await assert.rejects(
      () => analyzeLocalVideo(videoPath, "?", { apiKey: API_KEY, model: "m", fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof GleanError);
        assert.equal(error.kind, "quota");
        assert.ok(!error.message.includes(API_KEY), "the API key leaked into the error");
        assert.match(error.message, /\[redacted]/);
        return true;
      },
    );
  });
});

describe("analyzeYouTube", () => {
  it("passes the URL straight through with no upload", async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "It covers React 19." }] } }] }),
    );

    const answer = await analyzeYouTube("https://youtu.be/abc123", "What is it about?", {
      apiKey: API_KEY,
      model: "m",
      fetchImpl,
    });

    assert.equal(answer, "It covers React 19.");
    assert.equal(requests.length, 1, "a YouTube URL must not be uploaded");
    const parts = (requests[0]!.body as { contents: Array<{ parts: unknown[] }> }).contents[0]!
      .parts;
    assert.deepEqual(parts[1], { file_data: { file_uri: "https://youtu.be/abc123" } });
  });

  it("rejects an empty candidate list instead of returning nothing", async () => {
    const { fetch: fetchImpl } = fakeFetch(() => jsonResponse({ candidates: [] }));
    await assert.rejects(
      () => analyzeYouTube("https://youtu.be/abc", "?", { apiKey: API_KEY, model: "m", fetchImpl }),
      /returned no text/,
    );
  });
});
