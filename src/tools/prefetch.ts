/**
 * Background content prefetch for `includeContent`.
 *
 * A push model, not a pull one: the search returns immediately, and when the
 * fetch finishes we wake the agent with `sendMessage({ triggerTurn: true })`
 * carrying a fresh id. Nothing polls, nothing awaits a promise it cannot see.
 *
 * The prefetch gets its own responseId rather than joining the search's — the
 * search record is already written and sent by the time these land.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "../activity.ts";
import { extractAll, type ExtractDeps } from "../fetch/extract.ts";
import { CUSTOM_TYPE, generateId, storeResult, stripThumbnails } from "../storage.ts";

/** In-flight prefetches, so session shutdown can abort them. */
const pending = new Map<string, AbortController>();
let sessionActive = true;

export function markSessionActive(active: boolean): void {
  sessionActive = active;
}

export function abortPendingFetches(): void {
  for (const controller of pending.values()) controller.abort();
  pending.clear();
}

export function pendingCount(): number {
  return pending.size;
}

export interface PrefetchDeps extends ExtractDeps {
  pi: ExtensionAPI;
}

/**
 * Starts a background fetch and returns its id immediately.
 *
 * Two guards keep a finished fetch from writing into a session that has moved
 * on: `sessionActive`, and the id still being in `pending`.
 */
export function startBackgroundFetch(urls: string[], deps: PrefetchDeps): string | null {
  if (urls.length === 0) return null;

  const fetchId = generateId();
  const controller = new AbortController();
  pending.set(fetchId, controller);

  void extractAll(urls, deps, { signal: controller.signal })
    .then((fetched) => {
      if (!sessionActive || !pending.has(fetchId)) return;

      const succeeded = fetched.filter((entry) => !entry.error).length;
      const data = {
        id: fetchId,
        type: "fetch" as const,
        timestamp: Date.now(),
        urls: stripThumbnails(fetched),
      };
      storeResult(fetchId, data);
      deps.pi.appendEntry(CUSTOM_TYPE, data);

      deps.pi.sendMessage(
        {
          customType: "glean-content-ready",
          // The configured name, not the default — the whole point of
          // toolNames is that a renamed tool still gets called.
          content:
            `Content fetched for ${succeeded}/${fetched.length} URLs [${fetchId}]. ` +
            `Full page content is now available via ${deps.config.toolNames.getContent}.`,
          display: true,
        },
        { triggerTurn: true },
      );
    })
    .catch((error: unknown) => {
      if (!sessionActive || !pending.has(fetchId)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("abort")) return;
      // Report, but do not interrupt whatever the agent is doing now.
      deps.pi.sendMessage(
        {
          customType: "glean-content-error",
          content: `Background content fetch failed [${fetchId}]: ${message}`,
          display: true,
        },
        { triggerTurn: false },
      );
      activityMonitor.logError(fetchId, message);
    })
    .finally(() => {
      pending.delete(fetchId);
    });

  return fetchId;
}
