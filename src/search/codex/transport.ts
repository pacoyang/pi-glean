/**
 * HTTP transport for the ChatGPT Codex backend.
 *
 * Sends the same headers as the codex Rust client — originator, account id,
 * and the impersonated User-Agent — with all requests routed through the
 * Cloudflare cookie jar.
 */

import { type FetchLike, wrapFetchWithCookies } from "./cookies.ts";
import { CODEX_ORIGINATOR, buildCodexUserAgent } from "./ua.ts";

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export interface TransportOptions {
  token: string;
  accountId: string;
  baseUrl?: string;
  clientVersion?: string;
  fetchImpl?: FetchLike;
}

export interface CodexTransport {
  fetch: FetchLike;
  baseUrl: string;
  buildHeaders(accept: string): Headers;
  endpoint(path: "models" | "responses"): string;
}

/** Accepts a base URL with or without the `/codex/...` suffix a user may paste in. */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  for (const suffix of ["/codex/responses", "/codex/models", "/codex"]) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized;
}

export function resolveEndpoint(baseUrl: string | undefined, path: "models" | "responses"): string {
  return `${normalizeBaseUrl(baseUrl)}/codex/${path}`;
}

export function createTransport(options: TransportOptions): CodexTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const rawFetch: FetchLike = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const fetchWithCookies = wrapFetchWithCookies(rawFetch);

  return {
    fetch: fetchWithCookies,
    baseUrl,
    buildHeaders(accept: string): Headers {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${options.token}`);
      headers.set("chatgpt-account-id", options.accountId);
      headers.set("originator", CODEX_ORIGINATOR);
      headers.set("accept", accept);
      if (accept === "text/event-stream") headers.set("content-type", "application/json");
      headers.set("User-Agent", buildCodexUserAgent(options.clientVersion));
      return headers;
    },
    endpoint(path) {
      return resolveEndpoint(baseUrl, path);
    },
  };
}
