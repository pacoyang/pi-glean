/**
 * Gemini for whole-video understanding.
 *
 * Optional throughout: frame extraction covers the common case with no key at
 * all, and this only adds "watch the whole thing and answer a question".
 *
 * Files are uploaded, polled until ACTIVE, queried, then deleted in a finally
 * block — a dangling upload counts against the account's storage.
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import { redactCredential } from "../credentials.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const UPLOAD_TIMEOUT_MS = 300_000;
const QUERY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 90;

export interface GeminiOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Test seam: how long to wait between processing-state polls. */
  pollIntervalMs?: number;
}

interface FileResource {
  name?: string;
  uri?: string;
  state?: string;
  mimeType?: string;
  error?: { message?: string };
}

function endpoint(options: GeminiOptions, path: string): string {
  return `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${path}`;
}

async function assertOk(response: Response, apiKey: string, what: string): Promise<void> {
  if (response.ok) return;
  const body = redactCredential(await response.text().catch(() => ""), apiKey);
  throw new GleanError(
    classifyHttpStatus(response.status),
    `Gemini ${what} failed: HTTP ${response.status}: ${formatHttpErrorBody(body, 300)}`,
    { status: response.status, source: "gemini" },
  );
}

function mimeTypeFor(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
  };
  return known[extension] ?? "video/mp4";
}

/** Resumable upload: start, then send the bytes. */
async function uploadFile(path: string, options: GeminiOptions): Promise<FileResource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bytes = await readFile(path);
  const info = await stat(path);
  const mimeType = mimeTypeFor(path);

  const start = await fetchImpl(
    endpoint(options, `/upload/v1beta/files?key=${encodeURIComponent(options.apiKey)}`),
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(info.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: basename(path) } }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  await assertOk(start, options.apiKey, "upload start");

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new GleanError("invalid-response", "Gemini did not return an upload URL", {
      source: "gemini",
    });
  }

  const upload = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(info.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(bytes),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await assertOk(upload, options.apiKey, "upload");

  const payload = (await upload.json()) as { file?: FileResource };
  const file = payload.file;
  if (!file?.name || !file.uri) {
    throw new GleanError("invalid-response", "Gemini upload returned no file handle", {
      source: "gemini",
    });
  }
  return file;
}

/** Video is transcoded server-side, so the file is not usable immediately. */
async function waitUntilActive(file: FileResource, options: GeminiOptions): Promise<FileResource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = file;

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    if (current.state === "ACTIVE") return current;
    if (current.state === "FAILED") {
      throw new GleanError(
        "invalid-response",
        `Gemini failed to process the video: ${current.error?.message ?? "unknown error"}`,
        { source: "gemini" },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? POLL_INTERVAL_MS));
    if (options.signal?.aborted) {
      throw new GleanError("aborted", "Video analysis was cancelled", { source: "gemini" });
    }

    const response = await fetchImpl(
      endpoint(options, `/v1beta/${current.name}?key=${encodeURIComponent(options.apiKey)}`),
      options.signal ? { signal: options.signal } : {},
    );
    await assertOk(response, options.apiKey, "file status");
    current = (await response.json()) as FileResource;
  }

  throw new GleanError("timeout", "Gemini did not finish processing the video in time", {
    source: "gemini",
  });
}

async function deleteFile(file: FileResource, options: GeminiOptions): Promise<void> {
  if (!file.name) return;
  try {
    await (options.fetchImpl ?? fetch)(
      endpoint(options, `/v1beta/${file.name}?key=${encodeURIComponent(options.apiKey)}`),
      { method: "DELETE" },
    );
  } catch {
    // A leftover upload is untidy, not a failure worth surfacing.
  }
}

async function generate(
  parts: unknown[],
  options: GeminiOptions,
  timeoutMs: number,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      endpoint(
        options,
        `/v1beta/models/${options.model}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: controller.signal,
      },
    );
    await assertOk(response, options.apiKey, "generateContent");

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new GleanError("invalid-response", "Gemini returned no text", { source: "gemini" });
    }
    return text;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Uploads a local video, asks the question, and always cleans the upload up. */
export async function analyzeLocalVideo(
  path: string,
  prompt: string,
  options: GeminiOptions,
): Promise<string> {
  const uploaded = await uploadFile(path, options);
  try {
    const active = await waitUntilActive(uploaded, options);
    return await generate(
      [{ text: prompt }, { file_data: { mime_type: active.mimeType, file_uri: active.uri } }],
      options,
      UPLOAD_TIMEOUT_MS,
    );
  } finally {
    await deleteFile(uploaded, options);
  }
}

/** Asks about a YouTube video by URL; no upload involved. */
export async function analyzeYouTube(
  url: string,
  prompt: string,
  options: GeminiOptions,
): Promise<string> {
  return generate([{ text: prompt }, { file_data: { file_uri: url } }], options, QUERY_TIMEOUT_MS);
}
