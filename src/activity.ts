/**
 * In-memory ring buffer of recent requests, rendered by the activity widget.
 *
 * `status === null` means in-flight; `logError` deliberately leaves it null so
 * the widget can distinguish "still running" from "failed without a response".
 */

import type { RateLimitInfo } from "./ratelimit.ts";

export interface ActivityEntry {
  id: string;
  type: "api" | "fetch";
  startTime: number;
  endTime?: number;
  /** Search queries. */
  query?: string;
  /** URL fetches. */
  url?: string;
  /** HTTP status, or null while pending / on a network error. */
  status: number | null;
  error?: string;
  /** Set when a fetch fell through to a fallback, e.g. "jina". */
  via?: string;
}

const MAX_ENTRIES = 10;

export class ActivityMonitor {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<() => void>();
  private rateLimits = new Map<string, RateLimitInfo>();
  private nextId = 1;

  logStart(partial: Omit<ActivityEntry, "id" | "startTime" | "status">): string {
    const id = `act-${this.nextId++}`;
    this.entries.push({ ...partial, id, startTime: Date.now(), status: null });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.notify();
    return id;
  }

  logComplete(id: string, status: number, via?: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.status = status;
    if (via !== undefined) entry.via = via;
    this.notify();
  }

  logError(id: string, error: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.error = error;
    this.notify();
  }

  getEntries(): readonly ActivityEntry[] {
    return this.entries;
  }

  /** Rate-limit state per source ("perplexity", "jina", …). */
  getRateLimits(): ReadonlyMap<string, RateLimitInfo> {
    return this.rateLimits;
  }

  updateRateLimit(source: string, info: RateLimitInfo): void {
    this.rateLimits.set(source, info);
    this.notify();
  }

  onUpdate(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  clear(): void {
    this.entries = [];
    this.rateLimits.clear();
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // A broken listener must not break the request it is observing.
      }
    }
  }
}

export const activityMonitor = new ActivityMonitor();
