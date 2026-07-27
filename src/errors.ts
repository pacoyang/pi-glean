/**
 * Error taxonomy for pi-glean.
 *
 * The union covers two axes: transport-level failures (including Cloudflare
 * challenges) and HTTP-status or message-derived ones, kept fine-grained enough
 * that a caller can tell a retryable failure from a fatal one.
 * `search.fallbackOn` keys off these names, so the exact spelling matters.
 */

/** The single source of truth, so config validation cannot drift from the type. */
export const ERROR_KINDS = [
  "credential",
  "auth",
  "invalid-request",
  "quota",
  "transient",
  "invalid-response",
  "network",
  "config",
  "aborted",
  "timeout",
  "schema",
  "missing_binary",
  "ssrf",
  "unsupported",
  "not_found",
  "unknown",
] as const;

export type GleanErrorKind = (typeof ERROR_KINDS)[number];

/** Kinds where retrying the same call is pointless but another backend may work. */
export const DEFAULT_FALLBACK_ON: readonly GleanErrorKind[] = ["quota", "transient", "network"];

export interface GleanErrorOptions {
  status?: number;
  /** Backend / subsystem that produced the error, for diagnostics. */
  source?: string;
  cause?: unknown;
  /** Actionable next step shown to the user verbatim. */
  hint?: string;
}

export class GleanError extends Error {
  readonly kind: GleanErrorKind;
  readonly status?: number;
  readonly source?: string;
  readonly hint?: string;

  constructor(kind: GleanErrorKind, message: string, options: GleanErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GleanError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.source !== undefined) this.source = options.source;
    if (options.hint !== undefined) this.hint = options.hint;
  }

  /** Message plus hint, for surfacing to the model or the user. */
  get displayMessage(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message;
  }
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (error.name === "TimeoutError") return true;
  }
  return errorMessage(error).toLowerCase().includes("abort");
}

/** Extracts a status code embedded in a message like "HTTP 429" or "error 503". */
export function statusFromMessage(message: string): number | undefined {
  const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

export function classifyHttpStatus(status: number): GleanErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "invalid-request";
  if (status === 402 || status === 429) return "quota";
  if (status === 404) return "not_found";
  if (status === 408 || status === 425 || status >= 500) return "transient";
  return "unknown";
}

/**
 * Classify an arbitrary thrown value.
 *
 * Order matters and is load-bearing: typed errors first, then abort, then HTTP
 * status, then message regexes. Status is checked before regexes so that a 429
 * whose body happens to mention "unauthorized" is still classified as `quota`.
 */
export function classifyError(error: unknown, source?: string): GleanError {
  if (error instanceof GleanError) return error;

  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const status = statusFromMessage(message);
  const opts: GleanErrorOptions = { cause: error };
  if (status !== undefined) opts.status = status;
  if (source !== undefined) opts.source = source;

  if (error instanceof CredentialResolutionError) {
    return new GleanError("credential", message, opts);
  }
  if (isAbortError(error)) {
    return new GleanError("aborted", message, opts);
  }
  if (status !== undefined) {
    const kind = classifyHttpStatus(status);
    if (kind !== "unknown") return new GleanError(kind, message, opts);
  }

  if (/(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
    return new GleanError("credential", message, opts);
  }
  if (/rate limit|quota|too many requests/.test(lower)) {
    return new GleanError("quota", message, opts);
  }
  if (/unauthorized|unauthorised|forbidden|permission denied/.test(lower)) {
    return new GleanError("auth", message, opts);
  }
  if (/bad request|invalid request/.test(lower)) {
    return new GleanError("invalid-request", message, opts);
  }
  if (
    /invalid json|no parseable response|returned invalid response|returned empty response/.test(
      lower,
    )
  ) {
    return new GleanError("invalid-response", message, opts);
  }
  if (/timed out|timeout/.test(lower)) {
    return new GleanError("timeout", message, opts);
  }
  if (/temporar|service unavailable|server error/.test(lower)) {
    return new GleanError("transient", message, opts);
  }
  if (
    error instanceof TypeError ||
    /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|socket/.test(lower)
  ) {
    return new GleanError("network", message, opts);
  }
  if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)) {
    return new GleanError("config", message, opts);
  }

  return new GleanError("unknown", message, opts);
}

export function isCloudflareChallenge(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("/cdn-cgi/challenge-platform/") ||
    lower.includes("cf_chl_") ||
    lower.includes("enable javascript and cookies to continue")
  );
}

/** Trims an HTTP error body and replaces Cloudflare interstitials with advice. */
export function formatHttpErrorBody(text: string, limit = 500): string {
  if (isCloudflareChallenge(text)) {
    return "Cloudflare challenge blocked the request. Retry after the upstream has refreshed its Cloudflare clearance.";
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
