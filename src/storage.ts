/**
 * Session-scoped result store.
 *
 * Results live in memory and are rehydrated from the pi session tree on start
 * and on branch navigation, so `glean_get_content` keeps working after a fork
 * or a `/tree` jump.
 *
 * The customType is `glean-results`, and must stay distinct from any other
 * extension's: `restoreFromSession` replays every matching entry on the branch,
 * so a shared name would make each extension ingest the other's records, with
 * `generateId()` collisions on top. `web-search-results` is one such name
 * already in use elsewhere.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Citation } from "./search/citations.ts";
import type { ExtractedContent } from "./fetch/types.ts";

export const CUSTOM_TYPE = "glean-results";
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface QueryResultData {
  query: string;
  backend: string;
  answer: string;
  citations: Citation[];
  error: string | null;
  /** Set when includeContent kicked off a background fetch for this query. */
  contentFetchId?: string;
}

export interface StoredSearchData {
  id: string;
  type: "search" | "fetch";
  timestamp: number;
  queries?: QueryResultData[];
  urls?: ExtractedContent[];
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
  storedResults.set(id, data);
}

/**
 * Drops expired records.
 *
 * The TTL used to apply only on rehydrate, so within one long session nothing
 * was ever released — every page and every synthesized answer stayed resident,
 * and `glean_get_content` promised an expiry that never happened.
 */
function prune(now: number): void {
  for (const [id, data] of storedResults) {
    if (now - data.timestamp >= CACHE_TTL_MS) storedResults.delete(id);
  }
}

export function getResult(id: string, now: number = Date.now()): StoredSearchData | null {
  prune(now);
  return storedResults.get(id) ?? null;
}

export function getAllResults(now: number = Date.now()): StoredSearchData[] {
  prune(now);
  return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
  return storedResults.delete(id);
}

export function clearResults(): void {
  storedResults.clear();
}

/**
 * Images must never reach the session log — they would bloat every replay and
 * blow past context limits on rehydrate.
 */
export function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
  return results.map((result) => {
    const { thumbnail: _thumbnail, frames: _frames, ...rest } = result;
    return rest;
  });
}

function isValidStoredData(data: unknown): data is StoredSearchData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return false;
  if (d.type !== "search" && d.type !== "fetch") return false;
  if (typeof d.timestamp !== "number") return false;
  if (d.type === "search" && !Array.isArray(d.queries)) return false;
  if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
  return true;
}

export function restoreFromSession(ctx: ExtensionContext, now: number = Date.now()): void {
  storedResults.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data;
    if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
      storedResults.set(data.id, data);
    }
  }
}
