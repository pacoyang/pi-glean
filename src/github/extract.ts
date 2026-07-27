/**
 * GitHub repository reading.
 *
 * A shallow clone beats scraping the HTML: the agent gets a real file tree and
 * a local path it can then `read` and `grep`. `gh repo clone` is preferred so
 * private repos work; plain `git clone` is the fallback.
 *
 * Clones live under a uid-scoped directory in `os.tmpdir()` at mode 0700.
 * Upstream used a fixed `/tmp/pi-github-repos`, which on a shared host is a
 * symlink-attack target and collides between users.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { activityMonitor } from "../activity.ts";
import { GleanError } from "../errors.ts";
import { run } from "../exec.ts";
import { formatBytes } from "../format.ts";
import type { ExtractedContent } from "../fetch/types.ts";
import {
  defaultBranch,
  fetchFile,
  fetchReadme,
  fetchTree,
  isGhAvailable,
  repoSizeKb,
  showGhHint,
  type GitHubUrlInfo,
} from "./api.ts";

export type { GitHubUrlInfo };

const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;
const README_LIMIT = 8192;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".tif",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".flv",
  ".wmv",
  ".wav",
  ".ogg",
  ".webm",
  ".flac",
  ".aac",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".zst",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".lib",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".sqlite",
  ".db",
  ".sqlite3",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".iso",
  ".img",
  ".dmg",
]);

/** Directories that are build output or dependencies, never worth listing. */
const NOISE_DIRS = new Set([
  "node_modules",
  "vendor",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** URL segments that are not code, so the page is better read as HTML. */
const NON_CODE_SEGMENTS = new Set([
  "issues",
  "pull",
  "pulls",
  "discussions",
  "releases",
  "wiki",
  "actions",
  "settings",
  "security",
  "projects",
  "graphs",
  "compare",
  "commits",
  "tags",
  "branches",
  "stargazers",
  "watchers",
  "network",
  "forks",
  "milestone",
  "labels",
  "packages",
  "codespaces",
  "contribute",
  "community",
  "sponsors",
  "invitations",
  "notifications",
  "insights",
]);

export interface GitHubConfig {
  enabled: boolean;
  maxRepoSizeMB: number;
  cloneTimeoutSeconds: number;
  clonePath: string;
}

interface CachedClone {
  localPath: string;
  clonePromise: Promise<string | null>;
}

const cloneCache = new Map<string, CachedClone>();

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");

  // Issues, PRs and the wiki are prose, not code — let the HTML path have them.
  const third = segments[2]?.toLowerCase();
  if (third && NON_CODE_SEGMENTS.has(third)) return null;

  if (segments.length === 2) return { owner, repo, refIsFullSha: false, type: "root" };

  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;

  const ref = segments[3]!;
  return {
    owner,
    repo,
    ref,
    refIsFullSha: /^[0-9a-f]{40}$/.test(ref),
    path: segments.slice(4).join("/"),
    type: action,
  };
}

function cacheKey(info: GitHubUrlInfo): string {
  return info.ref ? `${info.owner}/${info.repo}@${info.ref}` : `${info.owner}/${info.repo}`;
}

function cloneDir(config: GitHubConfig, info: GitHubUrlInfo): string {
  const dirName = info.ref ? `${info.repo}@${info.ref}` : info.repo;
  return join(config.clonePath, info.owner, dirName);
}

/**
 * Confirms a path stays inside the clone, following symlinks.
 *
 * A repository can contain a symlink pointing anywhere; without this a tree
 * walk would happily read outside the checkout.
 */
export function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
  const normalizedRoot = resolvePath(rootPath);
  const candidate = resolvePath(normalizedRoot, relativePath);

  if (candidate !== normalizedRoot) {
    const prefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
    if (!candidate.startsWith(prefix)) return null;
  }
  if (!existsSync(candidate)) return candidate;

  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const realPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
    return realCandidate.startsWith(realPrefix) ? candidate : null;
  } catch {
    return null;
  }
}

function isBinaryFile(filePath: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(512);
    const read = readSync(fd, buffer, 0, 512, 0);
    // A NUL byte in the first block is the classic binary signal.
    for (let i = 0; i < read; i++) if (buffer[i] === 0) return true;
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export function buildTree(rootPath: string): string {
  const entries: string[] = [];

  function walk(dir: string, relPath: string): void {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;

      const rel = relPath ? `${relPath}/${item}` : item;
      const safePath = resolveWithinRepo(rootPath, rel);
      if (!safePath) {
        entries.push(`${rel}  [outside repo skipped]`);
        continue;
      }

      let stat;
      try {
        stat = statSync(safePath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${rel}/  [skipped]`);
          continue;
        }
        entries.push(`${rel}/`);
        walk(safePath, rel);
      } else {
        entries.push(rel);
      }
    }
  }

  walk(rootPath, "");
  if (entries.length >= MAX_TREE_ENTRIES) {
    entries.push(`… (truncated at ${MAX_TREE_ENTRIES} entries)`);
  }
  return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
  const target = resolveWithinRepo(rootPath, subPath);
  if (!target) return "(path escapes repository root)";

  let items: string[];
  try {
    items = readdirSync(target).sort();
  } catch {
    return "(directory not readable)";
  }

  const lines: string[] = [];
  for (const item of items) {
    if (item === ".git") continue;
    const rel = subPath ? `${subPath}/${item}` : item;
    const safePath = resolveWithinRepo(rootPath, rel);
    if (!safePath) {
      lines.push(`  ${item}  (outside repo)`);
      continue;
    }
    try {
      const stat = statSync(safePath);
      lines.push(stat.isDirectory() ? `  ${item}/` : `  ${item}  (${formatBytes(stat.size)})`);
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }
  return lines.join("\n");
}

function readReadme(localPath: string): string | null {
  for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
    const readmePath = join(localPath, name);
    if (!existsSync(readmePath)) continue;
    try {
      const content = readFileSync(readmePath, "utf-8");
      return content.length > README_LIMIT
        ? `${content.slice(0, README_LIMIT)}\n\n[README truncated at 8K chars]`
        : content;
    } catch {
      continue;
    }
  }
  return null;
}

export function generateContent(localPath: string, info: GitHubUrlInfo): string {
  const lines = [`Repository cloned to: ${localPath}`, ""];

  if (info.type === "root") {
    lines.push("## Structure", buildTree(localPath), "");
    const readme = readReadme(localPath);
    if (readme) lines.push("## README", readme, "");
    // The clone is the point: the agent can now use its own file tools.
    lines.push("Use the `read`, `grep` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }

  if (info.type === "tree") {
    const dirPath = info.path ?? "";
    const fullPath = resolveWithinRepo(localPath, dirPath);
    if (!fullPath || !existsSync(fullPath)) {
      lines.push(
        `Path \`${dirPath}\` not found in the clone. Showing the repository root instead.`,
        "",
      );
      lines.push("## Structure", buildTree(localPath));
      return lines.join("\n");
    }
    lines.push(`## ${dirPath || "/"}`, buildDirListing(localPath, dirPath));
    return lines.join("\n");
  }

  const filePath = info.path ?? "";
  const fullPath = resolveWithinRepo(localPath, filePath);
  if (!fullPath || !existsSync(fullPath)) {
    lines.push(
      `File \`${filePath}\` not found in the clone.`,
      "",
      "If the branch name contains a slash it may have been parsed as part of the path; " +
        "fetch the repository root and navigate from there.",
      "",
      "## Structure",
      buildTree(localPath),
    );
    return lines.join("\n");
  }
  if (isBinaryFile(fullPath)) {
    let size = 0;
    try {
      size = statSync(fullPath).size;
    } catch {
      // Size is decoration here; absence is not worth failing over.
    }
    lines.push(`\`${filePath}\` is a binary file (${formatBytes(size)}).`);
    return lines.join("\n");
  }

  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    lines.push(`\`${filePath}\` could not be read.`);
    return lines.join("\n");
  }
  if (content.length > MAX_INLINE_FILE_CHARS) {
    content = `${content.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at ${MAX_INLINE_FILE_CHARS} chars — read it from the clone path above.]`;
  }
  lines.push(`## ${filePath}`, "", content);
  return lines.join("\n");
}

async function cloneRepo(
  info: GitHubUrlInfo,
  config: GitHubConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const localPath = cloneDir(config, info);
  try {
    rmSync(localPath, { recursive: true, force: true });
  } catch {
    // A leftover directory is not fatal; the clone will fail visibly if it is.
  }
  // 0700 on the shared root, so other users on the host cannot read the clone.
  await mkdir(config.clonePath, { recursive: true, mode: 0o700 });

  const timeoutMs = config.cloneTimeoutSeconds * 1000;
  const useGh = await isGhAvailable();
  if (!useGh) showGhHint();

  const args = useGh
    ? [
        "repo",
        "clone",
        `${info.owner}/${info.repo}`,
        localPath,
        "--",
        "--depth",
        "1",
        "--single-branch",
      ]
    : ["clone", "--depth", "1", "--single-branch"];
  if (info.ref) args.push("--branch", info.ref);
  if (!useGh) args.push(`https://github.com/${info.owner}/${info.repo}.git`, localPath);

  try {
    await run(useGh ? "gh" : "git", args, {
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return localPath;
  } catch {
    try {
      rmSync(localPath, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    return null;
  }
}

/** Read-only view assembled from the API, for oversized repos and SHA refs. */
async function fetchViaApi(
  url: string,
  info: GitHubUrlInfo,
  note?: string,
): Promise<ExtractedContent | null> {
  if (!(await isGhAvailable())) return null;
  const { owner, repo } = info;
  const lines: string[] = [];
  if (note) lines.push(note, "");

  if (info.type === "blob" && info.path) {
    const file = await fetchFile(owner, repo, info.path, info.ref);
    if (file === null) return null;
    lines.push(`## ${info.path}`, "", file);
    return {
      url,
      title: `${owner}/${repo} — ${info.path}`,
      content: lines.join("\n"),
      error: null,
      via: "github-api",
    };
  }

  const ref = info.ref ?? (await defaultBranch(owner, repo));
  if (!ref) return null;
  const tree = await fetchTree(owner, repo, ref);
  if (!tree) return null;

  const filtered = info.path ? tree.filter((entry) => entry.startsWith(`${info.path}/`)) : tree;
  lines.push("## Structure", filtered.slice(0, MAX_TREE_ENTRIES).join("\n"));
  if (filtered.length > MAX_TREE_ENTRIES) {
    lines.push(`… (truncated at ${MAX_TREE_ENTRIES} of ${filtered.length} entries)`);
  }

  if (info.type === "root") {
    const readme = await fetchReadme(owner, repo, info.ref);
    if (readme) {
      lines.push(
        "",
        "## README",
        readme.length > README_LIMIT ? `${readme.slice(0, README_LIMIT)}\n\n[truncated]` : readme,
      );
    }
  }

  return {
    url,
    title: `${owner}/${repo}`,
    content: lines.join("\n"),
    error: null,
    via: "github-api",
  };
}

export interface GitHubExtractDeps {
  config: GitHubConfig;
  signal?: AbortSignal;
  forceClone?: boolean;
}

/** Returns null when the URL is not a GitHub code URL, so the caller falls back to HTTP. */
export async function extractGitHub(
  url: string,
  deps: GitHubExtractDeps,
): Promise<ExtractedContent | null> {
  const info = parseGitHubUrl(url);
  if (!info || !deps.config.enabled) return null;
  if (deps.signal?.aborted) return null;

  const key = cacheKey(info);

  const finish = async (localPath: string | null): Promise<ExtractedContent | null> => {
    if (deps.signal?.aborted) return null;
    if (!localPath) return fetchViaApi(url, info);
    return {
      url,
      title: info.path ? `${info.owner}/${info.repo} — ${info.path}` : `${info.owner}/${info.repo}`,
      content: generateContent(localPath, info),
      error: null,
      via: "github",
    };
  };

  const cached = cloneCache.get(key);
  if (cached) return finish(await cached.clonePromise);

  // A 40-hex ref is a commit, which `git clone --branch` cannot take.
  if (info.refIsFullSha) {
    return fetchViaApi(
      url,
      info,
      "Note: commit SHA URLs are read through the GitHub API rather than cloned.",
    );
  }

  const activityId = activityMonitor.logStart({
    type: "fetch",
    url: `github.com/${info.owner}/${info.repo}`,
  });

  if (!deps.forceClone) {
    const sizeKb = await repoSizeKb(info.owner, info.repo);
    if (sizeKb !== null && sizeKb / 1024 > deps.config.maxRepoSizeMB) {
      const sizeMb = Math.round(sizeKb / 1024);
      const apiView = await fetchViaApi(
        url,
        info,
        `Note: this repository is ${sizeMb}MB, above the ${deps.config.maxRepoSizeMB}MB threshold, ` +
          "so it was read through the API rather than cloned. To clone it anyway, call this tool " +
          "again with the same URL and forceClone: true.",
      );
      activityMonitor.logComplete(activityId, apiView ? 200 : 0, "github-api");
      return apiView;
    }
  }

  // Another caller may have started a clone while the size check was awaited.
  const raced = cloneCache.get(key);
  if (raced) {
    activityMonitor.logComplete(activityId, 200, "github");
    return finish(await raced.clonePromise);
  }

  const clonePromise = cloneRepo(info, deps.config, deps.signal);
  cloneCache.set(key, { localPath: cloneDir(deps.config, info), clonePromise });

  const localPath = await clonePromise;
  if (!localPath) {
    cloneCache.delete(key);
    const apiFallback = await fetchViaApi(url, info);
    if (apiFallback) {
      activityMonitor.logComplete(activityId, 200, "github-api");
      return apiFallback;
    }
    activityMonitor.logError(activityId, "clone and API fallback both failed");
    // Null lets the caller drop through to plain HTTP rather than hard-failing.
    return null;
  }

  activityMonitor.logComplete(activityId, 200, "github");
  return finish(localPath);
}

/** Removes every clone made this session. Called on session shutdown. */
export function clearCloneCache(): void {
  for (const entry of cloneCache.values()) {
    try {
      rmSync(entry.localPath, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is preferable to a crash on shutdown.
    }
  }
  cloneCache.clear();
}

export function cloneCacheSize(): number {
  return cloneCache.size;
}

export { GleanError };
