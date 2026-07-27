/**
 * GitHub access through the `gh` CLI.
 *
 * Deliberately not raw `fetch` to api.github.com: `gh` already holds the user's
 * credentials, so private repos and higher rate limits come for free without
 * pi-glean ever handling a token.
 *
 * Used for size checks, for commit-SHA URLs (which cannot be shallow-cloned by
 * ref), and as the fallback when cloning is unavailable.
 */

import { GleanError } from "../errors.ts";
import { run, runText } from "../exec.ts";
import { detectBinary } from "../platform.ts";

const GH_TIMEOUT_MS = 20_000;

/**
 * Percent-encodes a value going into a `gh api` route.
 *
 * These routes are strings, and `gh` hands them to a client that normalizes the
 * path — so a `..` segment reaching this layer walks *up* the API, turning
 * `repos/o/r/contents/../../../user` into a call to `/user` as the
 * authenticated account. `new URL` collapses a literal `..` in the source URL,
 * but a `%2F`-encoded one survives to be decoded by the parser, so encoding
 * here is the reliable place to stop it.
 */
function encodeRoutePath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path?: string;
  type: "root" | "blob" | "tree";
}

let hintShown = false;

/** Printed once per process, not once per request. */
export function showGhHint(): void {
  if (hintShown) return;
  hintShown = true;
  console.error(
    "pi-glean: `gh` is not installed — falling back to plain `git clone`. " +
      "Private repositories and size checks need the GitHub CLI (https://cli.github.com).",
  );
}

export function resetGhHint(): void {
  hintShown = false;
}

export async function isGhAvailable(): Promise<boolean> {
  return detectBinary("gh");
}

/** Repository size in KB, or null when `gh` cannot answer. */
export async function repoSizeKb(owner: string, repo: string): Promise<number | null> {
  if (!(await isGhAvailable())) return null;
  try {
    const route = `repos/${encodeRoutePath(owner)}/${encodeRoutePath(repo)}`;
    const { stdout } = await runText("gh", ["api", route, "--jq", ".size"], {
      timeoutMs: GH_TIMEOUT_MS,
    });
    const size = Number(stdout.trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

async function ghJq(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("gh", args, { timeoutMs: GH_TIMEOUT_MS });
    return stdout.toString("utf-8");
  } catch (error) {
    if (error instanceof GleanError && error.kind === "missing_binary") return null;
    return null;
  }
}

export async function fetchTree(
  owner: string,
  repo: string,
  ref: string,
): Promise<string[] | null> {
  const out = await ghJq([
    "api",
    `repos/${encodeRoutePath(owner)}/${encodeRoutePath(repo)}/git/trees/${encodeRef(ref)}?recursive=1`,
    "--jq",
    ".tree[].path",
  ]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean);
}

export async function fetchReadme(
  owner: string,
  repo: string,
  ref?: string,
): Promise<string | null> {
  const base = `repos/${encodeRoutePath(owner)}/${encodeRoutePath(repo)}/readme`;
  const out = await ghJq(["api", ref ? `${base}?ref=${encodeRef(ref)}` : base, "--jq", ".content"]);
  if (!out) return null;
  try {
    return Buffer.from(out.replace(/\s/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export async function fetchFile(
  owner: string,
  repo: string,
  filePath: string,
  ref?: string,
): Promise<string | null> {
  const query = ref ? `?ref=${encodeRef(ref)}` : "";
  const out = await ghJq([
    "api",
    `repos/${encodeRoutePath(owner)}/${encodeRoutePath(repo)}/contents/${encodeRoutePath(filePath)}${query}`,
    "--jq",
    ".content",
  ]);
  if (!out) return null;
  try {
    return Buffer.from(out.replace(/\s/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Default branch, needed because tree lookups require a concrete ref. */
export async function defaultBranch(owner: string, repo: string): Promise<string | null> {
  const out = await ghJq([
    "api",
    `repos/${encodeRoutePath(owner)}/${encodeRoutePath(repo)}`,
    "--jq",
    ".default_branch",
  ]);
  return out?.trim() || null;
}
