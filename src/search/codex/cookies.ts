/**
 * Process-local Cloudflare cookie jar for ChatGPT endpoints.
 *
 * Mirrors the constraints in codex's `chatgpt_cloudflare_cookies.rs`: HTTPS
 * only, a host allowlist, and a cookie-*name* allowlist covering Cloudflare
 * infrastructure cookies only. Account and session cookies are never stored —
 * this jar exists to survive bot-management challenges, not to hold credentials.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

const ALLOWED_HOSTS = ["chatgpt.com", "chat.openai.com", "chatgpt-staging.com"];
const HOST_SUFFIXES = [".chatgpt.com", ".chatgpt-staging.com"];

const ALLOWED_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.includes(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isAllowedCookieName(name: string): boolean {
  return ALLOWED_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

function parseSetCookie(header: string, url: URL): Cookie | undefined {
  const [pair] = header.split(";");
  if (!pair) return undefined;
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  if (!isAllowedCookieName(name)) return undefined;
  return { name, value: pair.slice(eq + 1).trim(), domain: url.hostname, path: "/" };
}

export class CloudflareCookieStore {
  private cookies = new Map<string, Cookie>();

  set(headers: string[], url: URL): void {
    if (url.protocol !== "https:" || !isAllowedHost(url.hostname)) return;
    for (const header of headers) {
      const cookie = parseSetCookie(header, url);
      if (cookie) this.cookies.set(`${cookie.domain}:${cookie.path}:${cookie.name}`, cookie);
    }
  }

  header(url: URL): string | undefined {
    if (url.protocol !== "https:" || !isAllowedHost(url.hostname)) return undefined;
    const parts: string[] = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.domain === url.hostname) parts.push(`${cookie.name}=${cookie.value}`);
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  clear(): void {
    this.cookies.clear();
  }
}

const SHARED_STORE = new CloudflareCookieStore();

export function getCookieStore(): CloudflareCookieStore {
  return SHARED_STORE;
}

function readSetCookie(response: Response): string[] {
  const modern = response.headers.getSetCookie?.();
  if (modern) return modern;
  const legacy = response.headers.get("set-cookie");
  if (!legacy) return [];
  return legacy
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function wrapFetchWithCookies(
  fetchImpl: FetchLike,
  store: CloudflareCookieStore = SHARED_STORE,
): FetchLike {
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const cookieHeader = store.header(url);
    if (cookieHeader) {
      const existing = headers.get("cookie");
      headers.set("cookie", existing ? `${existing}; ${cookieHeader}` : cookieHeader);
    }

    const response = await fetchImpl(input, { ...init, headers });
    const setCookie = readSetCookie(response);
    if (setCookie.length > 0) store.set(setCookie, url);
    return response;
  };
}
