/**
 * Derived from pi-web-access v0.14.0 — ssrf-protection.ts
 * https://github.com/nicobailon/pi-web-access
 * Copyright (c) 2025 Nico Bailon. MIT — see NOTICE.
 * Modifications Copyright (c) 2026 pacoyang. MIT.
 *
 * Copied rather than rewritten: this is the only layer standing between a
 * prompt-injected URL and the host's internal network, the CIDR tables and
 * per-hop redirect revalidation are already proven, and a rewrite would only
 * create fresh opportunities for holes.
 *
 * Changes from upstream: configuration is injected instead of read from disk
 * (see §3 of the plan), and a regex escaping bug in NO_PROXY port matching is
 * fixed — `/^:\\d+$/` matched a literal backslash, so a bracketed IPv6 entry
 * with a port silently matched every port.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type Fetch = typeof fetch;

export interface DomainPolicy {
  allow: string[];
  deny: string[];
}

export interface ValidationOptions {
  /** Test seam, and the reason the whole guard is unit-testable without DNS. */
  lookup?: Lookup;
  domainPolicy?: DomainPolicy;
  /**
   * CIDRs exempt from the private-address check. Needed when a TUN/fake-IP
   * proxy (Surge, Clash, Mihomo…) resolves public domains into a reserved
   * range. Entries are validated strictly so a typo cannot silently disable
   * the guard.
   */
  allowRanges?: string[];
  /**
   * Trust an explicitly configured HTTP(S) proxy for resolution instead of
   * doing local DNS. Literal IPs and localhost stay blocked, and NO_PROXY hosts
   * still take the local preflight.
   */
  trustEnvProxy?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface FetchRemoteOptions extends ValidationOptions {
  fetch?: Fetch;
  maxRedirects?: number;
}

interface ParsedCidr {
  bytes: Uint8Array;
  prefix: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export async function validateRemoteUrl(
  rawUrl: string | URL,
  options: ValidationOptions = {},
): Promise<URL> {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  const allowRanges = parseAllowRanges(options.allowRanges);
  assertDomainPolicy(hostname, options.domainPolicy);

  if (net.isIP(hostname)) {
    assertPublicAddress(hostname, hostname, allowRanges);
    return url;
  }

  if (shouldTrustEnvProxy(url, options.trustEnvProxy === true, options.env ?? process.env)) {
    return url;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ${hostname}: ${message}`);
  }

  if (addresses.length === 0) {
    throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  }
  // Every resolved address must be public: one private answer is enough to
  // reach an internal service via DNS rebinding.
  for (const { address } of addresses) {
    assertPublicAddress(address, hostname, allowRanges);
  }
  return url;
}

/**
 * Fetch with the guard applied to every hop.
 *
 * Redirects are followed manually so each new location is revalidated — a
 * public URL that 302s to 169.254.169.254 must not slip through.
 */
export async function fetchRemoteUrl(
  url: string | URL,
  init: RequestInit = {},
  options: FetchRemoteOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateRemoteUrl(url, options);
  let requestInit = init;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(current, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) {
      throw new Error(`Too many redirects fetching ${current.toString()}`);
    }

    current = await validateRemoteUrl(new URL(location, current), options);
    const method = requestInit.method?.toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      const { body: _body, ...nextInit } = requestInit;
      requestInit = { ...nextInit, method: "GET" };
    }
  }

  throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function assertDomainPolicy(hostname: string, policy?: DomainPolicy): void {
  if (!policy) return;
  if (policy.deny.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Blocked hostname by domain policy: ${hostname}`);
  }
  if (policy.allow.length > 0 && !policy.allow.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Hostname not allowed by domain policy: ${hostname}`);
  }
}

function domainMatches(hostname: string, entry: string): boolean {
  return hostname === entry || hostname.endsWith(`.${entry}`);
}

function getProxyForProtocol(protocol: string, env: NodeJS.ProcessEnv): string {
  const candidates =
    protocol === "http:"
      ? [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
      : protocol === "https:"
        ? [
            env.HTTPS_PROXY,
            env.https_proxy,
            env.HTTP_PROXY,
            env.http_proxy,
            env.ALL_PROXY,
            env.all_proxy,
          ]
        : [];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const proxyUrl = new URL(value);
      if ((proxyUrl.protocol === "http:" || proxyUrl.protocol === "https:") && proxyUrl.hostname) {
        return value;
      }
    } catch {
      // A malformed proxy variable must not weaken the local DNS check.
    }
  }
  return "";
}

function hostnameMatchesNoProxy(hostname: string, port: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;

  // Entries may carry a port. Strip it only after handling bracketed IPv6
  // literals, which contain several colons of their own.
  let hostEntry = trimmed;
  let entryPort: string | undefined;
  if (hostEntry.startsWith("[")) {
    const closingBracket = hostEntry.indexOf("]");
    if (closingBracket >= 0) {
      const suffix = hostEntry.slice(closingBracket + 1);
      // Upstream had /^:\\d+$/ here, which matches a literal backslash and so
      // never fired — a bracketed entry with a port matched every port.
      if (/^:\d+$/.test(suffix)) entryPort = suffix.slice(1);
      hostEntry = hostEntry.slice(0, closingBracket + 1);
    }
  } else {
    const colon = hostEntry.lastIndexOf(":");
    if (colon > -1 && /^\d+$/.test(hostEntry.slice(colon + 1))) {
      entryPort = hostEntry.slice(colon + 1);
      hostEntry = hostEntry.slice(0, colon);
    }
  }
  if (entryPort !== undefined && entryPort !== port) return false;

  const normalizedEntry = normalizeHostname(hostEntry);
  if (!normalizedEntry) return false;
  if (normalizedEntry === hostname) return true;
  const suffix = normalizedEntry.startsWith("*.")
    ? normalizedEntry.slice(1)
    : normalizedEntry.startsWith(".")
      ? normalizedEntry
      : `.${normalizedEntry}`;
  return hostname.endsWith(suffix);
}

function shouldTrustEnvProxy(url: URL, enabled: boolean, env: NodeJS.ProcessEnv): boolean {
  if (!enabled || !getProxyForProtocol(url.protocol, env)) return false;
  const hostname = normalizeHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const noProxy = env.NO_PROXY || env.no_proxy || "";
  return !noProxy.split(",").some((entry) => hostnameMatchesNoProxy(hostname, port, entry));
}

function assertPublicAddress(
  address: string,
  hostname: string,
  allowRanges: ParsedCidr[] = [],
): void {
  const normalized = normalizeHostname(address);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;

  if (ipVersion === 4 && isBlockedIPv4(normalized)) {
    const hint = isFakeIpProxyAddress(normalized)
      ? '. This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies. If that matches your setup, set ssrf.allowRanges to ["198.18.0.0/15"] in pi-glean.json.'
      : "";
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}${hint}`);
  }
  if (ipVersion === 6 && isBlockedIPv6(normalized)) {
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  }
}

function isFakeIpProxyAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    isFakeIpProxyAddress(address) ||
    a >= 224 // multicast and reserved
  );
}

export function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true;

  const first = groups[0]!;
  if (groups.every((group) => group === 0)) return true; // unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // loopback
  if ((first & 0xfe00) === 0xfc00) return true; // unique local
  if ((first & 0xffc0) === 0xfe80) return true; // link-local

  const isMappedIPv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedIPv4) {
    const ipv4 = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
    return isBlockedIPv4(ipv4);
  }
  return false;
}

function parseIPv6(input: string): number[] | null {
  let address = input;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number) as [number, number, number, number];
    address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${(
      (octets[2] << 8) |
      octets[3]
    ).toString(16)}`;
  }

  const pieces = address.split("::");
  if (pieces.length > 2) return null;

  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 0) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
    return parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/** Throws on a malformed entry so a typo cannot silently widen the guard. */
export function parseAllowRanges(input: unknown): ParsedCidr[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("ssrf.allowRanges must be an array of CIDR strings");

  const rules: ParsedCidr[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new Error(`ssrf.allowRanges entries must be strings, got ${typeof entry}`);
    }
    const rule = parseCidr(entry.trim());
    if (!rule) throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
    rules.push(rule);
  }
  return rules;
}

function parseCidr(raw: string): ParsedCidr | null {
  if (!raw) return null;
  const slash = raw.lastIndexOf("/");
  const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
  // A slash must be followed by digits: Number("") is 0, which would turn
  // "198.18.0.0/" into /0 and exempt the entire address space.
  if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
  const version = net.isIP(addrPart);

  if (version === 4) {
    const bytes = ipv4ToBytes(addrPart);
    if (!bytes) return null;
    const prefix = prefixPart === null ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    return { bytes, prefix };
  }
  if (version === 6) {
    const groups = parseIPv6(addrPart);
    if (!groups) return null;
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
    return { bytes: ipv6GroupsToBytes(groups), prefix };
  }
  return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const octet = Number(parts[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i]! >> 8;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
  if (version === 4) return ipv4ToBytes(address);
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups ? ipv6GroupsToBytes(groups) : null;
  }
  return null;
}

function isInAllowedRange(address: string, ipVersion: number, allowRanges: ParsedCidr[]): boolean {
  if (allowRanges.length === 0) return false;
  const addrBytes = ipToBytes(address, ipVersion);
  if (!addrBytes) return false;
  for (const rule of allowRanges) {
    if (rule.bytes.length !== addrBytes.length) continue; // never mix families
    if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
  }
  return false;
}

function bytesMatchPrefix(addr: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const fullBytes = prefix >> 3;
  const remBits = prefix & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (addr[i] !== network[i]) return false;
  }
  if (remBits > 0 && fullBytes < addr.length) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((addr[fullBytes]! & mask) !== (network[fullBytes]! & mask)) return false;
  }
  return true;
}

/**
 * True when a host resolves somewhere private.
 *
 * Used by the Jina fallback: even if `ssrf.allowRanges` permits an internal
 * address locally, its URL must never be handed to a third-party renderer.
 */
export async function resolvesPrivately(hostname: string, lookup?: Lookup): Promise<boolean> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const version = net.isIP(normalized);
  if (version === 4) return isBlockedIPv4(normalized);
  if (version === 6) return isBlockedIPv6(normalized);

  try {
    const addresses = await (lookup ?? defaultLookup)(normalized);
    if (addresses.length === 0) return true;
    return addresses.some(({ address }) => {
      const v = net.isIP(address);
      if (v === 4) return isBlockedIPv4(address);
      if (v === 6) return isBlockedIPv6(address);
      return true;
    });
  } catch {
    return true; // Unresolvable: treat as unsafe to forward.
  }
}
