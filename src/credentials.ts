/**
 * Credential resolution for the optional API keys (tavily, perplexity, jina,
 * gemini). Subscription credentials never come through here — those are owned
 * by pi's ModelRegistry.
 *
 * A configured value may be:
 *   "$NAME" / "${NAME}"  read that environment variable, fail loudly if empty
 *   "!command"           run at request time, use trimmed stdout
 *   "$$literal"          escape — yields "$literal"
 *   "$!literal"          escape — yields "!literal"
 *   anything else        used as a literal, but an env var of the same purpose wins
 *
 * Commands run with a minimized environment so a leaked credential helper can't
 * read unrelated secrets, and their output is length- and charset-checked.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CredentialResolutionError } from "./errors.ts";

const execAsync = promisify(exec);

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_CREDENTIAL_BYTES = 16_384;
const ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const OP_SESSION_NAME = /^OP_SESSION_[A-Za-z0-9_]+$/;
/** Deliberately matches control characters — see resolveCredential. */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Passed through to credential commands; everything else is withheld. */
const COMMAND_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
] as const;

export type CredentialFailure =
  | "invalid-source"
  | "command-failed"
  | "command-timeout"
  | "command-aborted"
  | "command-empty"
  | "command-invalid-output"
  | "command-output-too-large"
  | "environment-empty";

export interface CommandResult {
  stdout: string | Buffer;
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  environment: Record<string, string>;
}

export type CommandRunner = (command: string, options: CommandOptions) => Promise<CommandResult>;

export interface ResolveOptions {
  /** Named in error messages, e.g. "tavily". */
  provider: string;
  configuredValue?: unknown;
  environmentValue?: unknown;
  environment?: Record<string, string | undefined>;
  signal?: AbortSignal;
  runCommand?: CommandRunner;
}

function fail(provider: string, failure: CredentialFailure): CredentialResolutionError {
  const suffix = failure === "command-aborted" ? "aborted" : failure;
  return new CredentialResolutionError(`${provider} credential resolution failed: ${suffix}`);
}

/** Replaces every occurrence of the credential with `[redacted]`. */
export function redactCredential(text: string, credential: string | null | undefined): string {
  return credential ? text.split(credential).join("[redacted]") : text;
}

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function commandEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of COMMAND_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // 1Password session tokens are the common case for `!op read …`.
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && OP_SESSION_NAME.test(name)) env[name] = value;
  }
  return env;
}

function explicitEnvName(source: string): string | null {
  const match = source.match(ENV_SOURCE);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function unescape(source: string): string | null {
  return source.startsWith("$$") || source.startsWith("$!") ? source.slice(1) : null;
}

function isMalformedEnvSource(source: string): boolean {
  return source.startsWith("$") && unescape(source) === null && explicitEnvName(source) === null;
}

async function defaultRunCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const result = await execAsync(command, {
    encoding: "utf8",
    env: options.environment,
    maxBuffer: options.maxOutputBytes + 1,
    signal: options.signal,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: result.stdout };
}

function commandFailure(error: unknown, signal?: AbortSignal): CredentialFailure {
  if (signal?.aborted) return "command-aborted";
  if (error && typeof error === "object") {
    const code = (error as { code?: string }).code;
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "command-output-too-large";
    if ((error as { killed?: boolean }).killed || code === "ETIMEDOUT") return "command-timeout";
  }
  return "command-failed";
}

/** True when anything at all is configured — used to decide whether to register a provider. */
export function hasCredentialSource(options: ResolveOptions): boolean {
  const source = normalize(options.configuredValue);
  if (source !== null) return true;
  return normalize(options.environmentValue) !== null;
}

export async function resolveCredential(options: ResolveOptions): Promise<string | null> {
  const source = normalize(options.configuredValue);

  const escaped = source ? unescape(source) : null;
  if (escaped !== null) return escaped;

  if (source?.startsWith("!")) {
    const command = source.slice(1).trim();
    if (!command) throw fail(options.provider, "invalid-source");

    let result: CommandResult;
    try {
      result = await (options.runCommand ?? defaultRunCommand)(command, {
        signal: options.signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_CREDENTIAL_BYTES,
        environment: commandEnvironment(options.environment ?? process.env),
      });
    } catch (error) {
      throw fail(options.provider, commandFailure(error, options.signal));
    }

    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    if (Buffer.byteLength(stdout, "utf8") > MAX_CREDENTIAL_BYTES) {
      throw fail(options.provider, "command-output-too-large");
    }
    const value = stdout.trim();
    if (!value) throw fail(options.provider, "command-empty");
    // Matching control characters is the whole point here: a credential helper
    // that emits a prompt, a spinner, or an ANSI escape has not returned a
    // usable secret, and passing that through would put terminal escapes into
    // an Authorization header.
    // oxlint-disable-next-line no-control-regex
    if (CONTROL_CHARS.test(value)) throw fail(options.provider, "command-invalid-output");
    return value;
  }

  if (source && isMalformedEnvSource(source)) {
    throw fail(options.provider, "invalid-source");
  }

  if (source?.startsWith("$")) {
    const name = explicitEnvName(source);
    if (!name) throw fail(options.provider, "invalid-source");
    const value = normalize((options.environment ?? process.env)[name]);
    if (!value) throw fail(options.provider, "environment-empty");
    return value;
  }

  return normalize(options.environmentValue) ?? source;
}
