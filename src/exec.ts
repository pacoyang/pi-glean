/**
 * Async child-process runner.
 *
 * Replaces the `execFileSync` calls in the upstream media code, which blocked
 * the event loop for up to 30s per invocation and made `Promise.all` over frame
 * timestamps serial-in-disguise.
 *
 * The sync and callback APIs report failures differently (`err.killed` +
 * `err.signal` vs a bare `ETIMEDOUT`; stderr is a Buffer or a string depending
 * on `encoding`), so classification here is deliberately explicit rather than
 * ported verbatim.
 */

import { execFile } from "node:child_process";
import { GleanError } from "./errors.ts";
import { missingBinaryMessage } from "./platform.ts";

export interface RunOptions {
  timeoutMs: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL when a timeout fires. */
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

interface ExecFailure extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

function asString(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf-8") : value;
}

function isMissingBinary(err: ExecFailure): boolean {
  return err.code === "ENOENT";
}

function isMaxBufferExceeded(err: ExecFailure): boolean {
  return (
    err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    err.message.toLowerCase().includes("maxbuffer")
  );
}

/**
 * Run a binary and collect stdout as a Buffer (frames come back as JPEG bytes).
 *
 * Throws {@link GleanError} with kind `missing_binary`, `timeout`, `aborted`,
 * `invalid-response` (maxBuffer overflow) or `transient` (non-zero exit).
 * `stderr` is preserved on the error so callers can map tool-specific failures.
 */
export function run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<RunResult>((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = execFile(
      file,
      args,
      { encoding: "buffer", maxBuffer, cwd: options.cwd, env: options.env },
      (error, stdout, stderr) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);

        const stderrText = asString(stderr);

        if (!error) {
          resolve({ stdout: stdout as Buffer, stderr: stderrText });
          return;
        }

        const err = error as ExecFailure;
        const detail = stderrText.trim() || err.message;

        if (isMissingBinary(err)) {
          reject(
            new GleanError("missing_binary", missingBinaryMessage(file), {
              source: file,
              cause: err,
            }),
          );
          return;
        }
        if (aborted) {
          reject(new GleanError("aborted", `${file} was cancelled`, { source: file, cause: err }));
          return;
        }
        if (timedOut) {
          reject(
            new GleanError("timeout", `${file} timed out after ${options.timeoutMs}ms`, {
              source: file,
              cause: err,
            }),
          );
          return;
        }
        if (isMaxBufferExceeded(err)) {
          reject(
            new GleanError("invalid-response", `${file} produced more than ${maxBuffer} bytes`, {
              source: file,
              cause: err,
            }),
          );
          return;
        }
        reject(
          new GleanError("transient", `${file} failed: ${detail}`, { source: file, cause: err }),
        );
      },
    );

    // Escalate to SIGKILL — a wedged ffmpeg must not outlive the tool call.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, options.timeoutMs);

    function onAbort() {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Convenience wrapper for binaries whose stdout is text. */
export async function runText(
  file: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  const result = await run(file, args, options);
  return { stdout: result.stdout.toString("utf-8"), stderr: result.stderr };
}

/** Maps ffmpeg/ffprobe failures onto messages that say what to do next. */
export function mapFfmpegError(error: unknown): GleanError {
  if (!(error instanceof GleanError)) {
    return new GleanError("unknown", String(error), { cause: error });
  }
  if (error.kind === "transient" && /403|forbidden/i.test(error.message)) {
    return new GleanError(
      "transient",
      "Stream URL was rejected (403) — it may have expired. Re-resolve the stream and retry.",
      { source: error.source, cause: error },
    );
  }
  return error;
}

/** Maps yt-dlp failures onto the specific reason YouTube refused. */
export function mapYtDlpError(error: unknown): GleanError {
  if (!(error instanceof GleanError)) {
    return new GleanError("unknown", String(error), { cause: error });
  }
  const lower = error.message.toLowerCase();
  if (/private video|unavailable|removed/.test(lower)) {
    return new GleanError("not_found", "Video is private, removed, or otherwise unavailable.", {
      source: "yt-dlp",
      cause: error,
    });
  }
  if (/age.?restricted|sign in to confirm/.test(lower)) {
    return new GleanError("auth", "Video is age-restricted and requires a signed-in session.", {
      source: "yt-dlp",
      cause: error,
      hint: "Supply your own flags via youtube.ytDlpArgs if you need authenticated access.",
    });
  }
  if (/not available in your country|geo.?restricted|blocked/.test(lower)) {
    return new GleanError("unsupported", "Video is region-blocked.", {
      source: "yt-dlp",
      cause: error,
    });
  }
  if (/is live|live event/.test(lower)) {
    return new GleanError("unsupported", "Live streams are not supported.", {
      source: "yt-dlp",
      cause: error,
    });
  }
  return error;
}
