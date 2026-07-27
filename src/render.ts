/**
 * Tool call and result rendering.
 *
 * Long operations must show progress — extracting twelve frames or fetching
 * five pages otherwise leaves the terminal silent for a minute.
 *
 * The error path renders in both collapsed and expanded form. Upstream returned
 * a single line early on errors, which made Ctrl+O a dead end: the shortcut
 * flipped `expanded` with nothing extra to show.
 *
 * Plans are plain strings with no theme applied, so they can be asserted
 * without a TUI.
 */

import { formatSeconds, truncate } from "./format.ts";

const COLLAPSED_PREVIEW = 200;
const EXPANDED_PREVIEW = 500;
const PROGRESS_WIDTH = 10;

export interface ErrorDetails {
  error?: string;
  kind?: string;
  hint?: string;
  /** Extra diagnostic lines: attempted backends, URLs, response ids. */
  extraLines?: string[];
}

export interface ErrorPlan {
  /** Full diagnostics, shown when expanded. */
  expanded: string[];
  /** Short preview under the headline when collapsed. */
  collapsed: string[];
  /** "… (N more lines, ctrl+o to expand)", or null when nothing is hidden. */
  expandHint: string | null;
}

/** Returns null when there is no error, so callers fall through to the success renderer. */
export function buildErrorPlan(details: ErrorDetails | undefined | null): ErrorPlan | null {
  if (!details?.error) return null;

  const headline = details.kind ? `${details.error} [${details.kind}]` : details.error;
  const extras = details.extraLines ?? [];
  const hintLines = details.hint ? details.hint.split("\n") : [];

  // A bare argument error stays one clean line — there is nothing to diagnose.
  if (extras.length === 0 && hintLines.length === 0) {
    return { expanded: [headline], collapsed: [], expandHint: null };
  }

  const expanded = [headline, ""];
  if (hintLines.length > 0) expanded.push(...hintLines, "");
  if (extras.length > 0) expanded.push("Details:", ...extras.map((line) => `  ${line}`));

  const collapsed: string[] = [];
  if (hintLines[0]) collapsed.push(truncate(hintLines[0], 100));
  else if (extras[0]) collapsed.push(truncate(extras[0], 100));

  const hiddenLines = Math.max(0, expanded.length - (1 + collapsed.length));
  return {
    expanded,
    collapsed,
    expandHint:
      hiddenLines > 0
        ? `… (${hiddenLines} more lines, ${expanded.length} total, ctrl+o to expand)`
        : null,
  };
}

export function renderErrorPlan(plan: ErrorPlan, expanded: boolean): string {
  if (expanded) return plan.expanded.join("\n");
  return [plan.expanded[0]!, ...plan.collapsed, plan.expandHint].filter(Boolean).join("\n");
}

/** `[████░░░░░░] fetching` */
export function progressBar(progress: number, phase: string): string {
  const clamped = Math.max(0, Math.min(1, progress));
  const filled = Math.floor(clamped * PROGRESS_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(PROGRESS_WIDTH - filled)}] ${phase}`;
}

export interface FetchResultDetails {
  urlCount?: number;
  successful?: number;
  totalChars?: number;
  title?: string;
  truncated?: boolean;
  via?: string;
  imageCount?: number;
  duration?: number;
  prompt?: string;
  timestamp?: string;
  frames?: number;
}

/** `[image]` / `[3 images]`, so the count is visible without expanding. */
export function imageBadge(count: number | undefined): string {
  if (!count || count < 1) return "";
  return count === 1 ? " [image]" : ` [${count} images]`;
}

export function renderFetchStatus(details: FetchResultDetails): string {
  if ((details.urlCount ?? 0) !== 1) {
    return `${details.successful ?? 0}/${details.urlCount ?? 0} URLs (content stored)`;
  }
  let line = `${details.title || "Untitled"} (${details.totalChars ?? 0} chars)`;
  line += imageBadge(details.imageCount);
  if (details.truncated) line += " [truncated]";
  if (details.via) line += ` · via ${details.via}`;
  if (typeof details.duration === "number") line += ` | ${formatSeconds(details.duration)} total`;
  return line;
}

export function renderFetchResult(
  details: FetchResultDetails,
  text: string,
  expanded: boolean,
): string {
  const status = renderFetchStatus(details);
  if (!expanded) {
    return `${status}\n${truncate(text, COLLAPSED_PREVIEW)}`;
  }
  const lines = [status];
  if (details.prompt) lines.push(`  prompt: "${truncate(details.prompt, 250)}"`);
  if (details.timestamp) lines.push(`  timestamp: ${details.timestamp}`);
  if (typeof details.frames === "number") lines.push(`  frames: ${details.frames}`);
  lines.push(truncate(text, EXPANDED_PREVIEW));
  return lines.join("\n");
}

export interface SearchResultDetails {
  queryCount?: number;
  successful?: number;
  backend?: string | string[];
  truncated?: boolean;
  contentFetchId?: string;
}

export function renderSearchStatus(details: SearchResultDetails): string {
  const backend = Array.isArray(details.backend) ? details.backend.join(", ") : details.backend;
  const parts = [`${details.successful ?? 0}/${details.queryCount ?? 0} queries`];
  if (backend) parts.push(`via ${backend}`);
  if (details.truncated) parts.push("[truncated]");
  if (details.contentFetchId) parts.push("· fetching sources");
  return parts.join(" ");
}

export function renderSearchResult(
  details: SearchResultDetails,
  text: string,
  expanded: boolean,
): string {
  const status = renderSearchStatus(details);
  return `${status}\n${truncate(text, expanded ? EXPANDED_PREVIEW : COLLAPSED_PREVIEW)}`;
}
