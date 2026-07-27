/**
 * Live activity panel, toggled with the configured shortcut.
 *
 * Long searches, multi-URL fetches and frame extraction otherwise give no sign
 * of life. `status === null` distinguishes in-flight from a network error that
 * never produced one, which is why `logError` leaves it unset.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { formatDuration, truncate } from "./format.ts";

const WIDGET_KEY = "glean-activity";
const LABEL_WIDTH = 34;

function describe(entry: ActivityEntry): string {
  if (entry.query) return `"${entry.query}"`;
  if (entry.url) {
    try {
      const url = new URL(entry.url);
      return `${url.hostname}${url.pathname}`;
    } catch {
      return entry.url;
    }
  }
  return "(unknown)";
}

function statusColumn(entry: ActivityEntry): string {
  if (entry.error) return "err";
  if (entry.status === null) return "···"; // still running
  return String(entry.status);
}

function outcome(entry: ActivityEntry): string {
  if (entry.error) return "✗";
  if (entry.status === null) return "";
  return entry.status >= 200 && entry.status < 400 ? "✓" : "✗";
}

export function renderActivityLines(
  entries: readonly ActivityEntry[],
  rateLimits: ReadonlyMap<string, { used: number; max: number }>,
  now = Date.now(),
): string[] {
  const lines = ["─── pi-glean Activity ───"];

  if (entries.length === 0) {
    lines.push("  (no requests yet)");
  } else {
    for (const entry of entries) {
      const kind = entry.type === "api" ? "API" : "GET";
      const label = truncate(describe(entry), LABEL_WIDTH).padEnd(LABEL_WIDTH);
      const elapsed = formatDuration((entry.endTime ?? now) - entry.startTime).padStart(6);
      const via = entry.via && entry.via !== "http" ? ` → ${entry.via}` : "";
      lines.push(
        `  ${kind}  ${label} ${statusColumn(entry).padStart(3)} ${elapsed} ${outcome(entry)}${via}`,
      );
    }
  }

  for (const [source, info] of rateLimits) {
    if (info.used === 0) continue;
    lines.push(`  ${source}: ${info.used}/${info.max} in window`);
  }

  lines.push("─".repeat(26));
  return lines;
}

export function registerActivityWidget(pi: ExtensionAPI, shortcut: string): void {
  let visible = false;
  let unsubscribe: (() => void) | null = null;

  const update = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(
      WIDGET_KEY,
      renderActivityLines(activityMonitor.getEntries(), activityMonitor.getRateLimits()),
      { placement: "aboveEditor" },
    );
  };

  try {
    // KeyId is a literal union, but this value comes from user config. pi
    // validates the binding itself; a bad one must cost the shortcut, not the
    // whole extension.
    pi.registerShortcut(shortcut as KeyId, {
      description: "Toggle pi-glean activity",
      handler: (ctx: ExtensionContext) => {
        visible = !visible;
        if (visible) {
          unsubscribe = activityMonitor.onUpdate(() => update(ctx));
          update(ctx);
        } else {
          // Unsubscribe before clearing, or the listener leaks across toggles.
          unsubscribe?.();
          unsubscribe = null;
          ctx.ui.setWidget(WIDGET_KEY, undefined);
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `pi-glean: could not bind the activity shortcut ${JSON.stringify(shortcut)}: ${message}`,
    );
  }
}
