/**
 * Three-layer configuration: env > project `.pi/pi-glean.json` > home
 * `~/.pi/pi-glean.json`. The project layer is skipped when the project is not
 * trusted.
 *
 * Validation is deliberately layered rather than exhaustive. Fields whose bad
 * values cause confusing downstream failures — enums, numeric ranges, array
 * element types — are checked strictly and reported with the source file. Free
 * strings (baseUrl / model / apiKey overrides) get a `typeof` check and are
 * passed through: if you mistype a URL, the HTTP error is closer to the truth
 * than anything this layer could say.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Backend } from "./search/citations.ts";
import { DEFAULT_FALLBACK_ON, type GleanErrorKind } from "./errors.ts";

export const CONFIG_FILE_NAME = "pi-glean.json";
export type ConfigScope = "project" | "home";

export type SearchContextSize = "low" | "medium" | "high";
export type Freshness = "cached" | "indexed" | "live";

export const BACKENDS: readonly Backend[] = [
  "codex",
  "xai",
  "tavily",
  "perplexity",
  "exa",
] as const;
export const DEFAULT_PROVIDERS: readonly Backend[] = [
  "codex",
  "xai",
  "tavily",
  "perplexity",
  "exa",
] as const;
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"] as const;
const FRESHNESS: readonly Freshness[] = ["cached", "indexed", "live"] as const;

export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 32;

/** Tool names pi ships itself. Shadowing one silently replaces a core tool. */
export const PI_BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export const DEFAULT_TOOL_NAMES = {
  search: "glean_search",
  xSearch: "glean_x_search",
  fetch: "glean_fetch",
  getContent: "glean_get_content",
} as const;

export type ToolKey = keyof typeof DEFAULT_TOOL_NAMES;

export interface ResolvedConfig {
  enabled: boolean;
  toolNames: Record<ToolKey, string>;
  tools: { search: boolean; xSearch: boolean; fetch: boolean };
  search: {
    backend: Backend | "auto";
    providers: Backend[];
    batchSize: number;
    fallbackOn: GleanErrorKind[];
    includeContentLimit: number;
    codex: {
      model?: string;
      baseUrl?: string;
      clientVersion?: string;
      searchContextSize: SearchContextSize;
      freshness: Freshness;
    };
    xai: { webSearchModel?: string; xSearchModel?: string; baseUrl?: string };
    exa: { mcpUrl?: string };
    tavily: { apiKey?: string };
    perplexity: {
      apiKey?: string;
      model?: string;
      rateLimit: { maxRequests: number; windowMs: number };
    };
  };
  fetch: {
    timeoutMs: number;
    maxInlineChars: number;
    jina: { enabled: boolean; apiKey?: string };
    domainPolicy: { allow: string[]; deny: string[] };
  };
  ssrf: { allowRanges: string[]; trustEnvProxy: boolean };
  github: {
    enabled: boolean;
    maxRepoSizeMB: number;
    cloneTimeoutSeconds: number;
    clonePath: string;
  };
  pdf: { maxPages: number; writeFile: boolean; outputDir: string };
  youtube: {
    enabled: boolean;
    subtitleLangs: string[];
    preferAutoSubs: boolean;
    gemini: { enabled: boolean };
    ytDlpArgs: string[];
  };
  video: { enabled: boolean; maxSizeMB: number; preferredModel: string };
  gemini: { apiKey?: string; baseUrl?: string };
  shortcuts: { activity: string };
  sources: { home?: unknown; project?: unknown; env?: unknown };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === "project") return join(cwd, ".pi", CONFIG_FILE_NAME);
  const override = process.env.PI_GLEAN_CONFIG;
  if (override) return override;
  return join(homedir(), ".pi", CONFIG_FILE_NAME);
}

/**
 * pi has changed the shape of `isProjectTrusted` across versions — boolean,
 * getter function, or absent. Tolerate all three; default to trusted, but treat
 * a throwing getter as untrusted.
 */
export function isProjectTrustedContext(ctx: unknown): boolean {
  if (ctx === null || ctx === undefined || typeof ctx !== "object") return true;
  const maybe = ctx as { isProjectTrusted?: unknown };
  if (typeof maybe.isProjectTrusted === "boolean") return maybe.isProjectTrusted;
  if (typeof maybe.isProjectTrusted !== "function") return true;
  try {
    return Boolean((maybe.isProjectTrusted as () => unknown)());
  } catch {
    return false;
  }
}

/** Per-user, non-world-readable scratch root. Never `$HOME`. */
export function scratchDir(prefix: string): string {
  let who: string;
  try {
    const info = userInfo();
    who = info.uid >= 0 ? String(info.uid) : info.username;
  } catch {
    who = "shared";
  }
  return join(tmpdir(), `pi-glean-${prefix}-${who}`);
}

type Raw = Record<string, unknown>;

async function readConfigFile(path: string): Promise<Raw | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`${path} must contain a JSON object`);
    }
    return parsed as Raw;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse ${path}: ${detail}`);
  }
}

function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Raw {
  const config: Raw = {};
  const enabled = env.PI_GLEAN_ENABLED;
  if (enabled !== undefined) {
    if (enabled !== "true" && enabled !== "false") {
      throw new ConfigError(
        `PI_GLEAN_ENABLED must be "true" or "false", got ${JSON.stringify(enabled)}`,
      );
    }
    config.enabled = enabled === "true";
  }
  return config;
}

/** One level deep, per top-level section: a project `fetch.timeoutMs` must not erase home's `fetch.jina`. */
function mergeSections(...layers: (Raw | undefined)[]): Raw {
  const out: Raw = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      const existing = out[key];
      const bothPlainObjects =
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
      out[key] = bothPlainObjects ? { ...(existing as Raw), ...(value as Raw) } : value;
    }
  }
  return out;
}

function section(raw: Raw, key: string, origin: string): Raw {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${key} in ${origin} must be an object`);
  }
  return value as Raw;
}

function str(raw: Raw, key: string, origin: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigError(`${path} in ${origin} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function bool(raw: Raw, key: string, origin: string, path: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path} in ${origin} must be a boolean`);
  return value;
}

function num(
  raw: Raw,
  key: string,
  origin: string,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} in ${origin} must be a number`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${path} in ${origin} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function enumValue<T extends string>(
  raw: Raw,
  key: string,
  origin: string,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConfigError(
      `${path} in ${origin} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function stringArray(
  raw: Raw,
  key: string,
  origin: string,
  path: string,
  fallback: string[],
): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value))
    throw new ConfigError(`${path} in ${origin} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new ConfigError(`${path}[${index}] in ${origin} must be a string`);
    }
    return entry;
  });
}

function providerList(raw: Raw, origin: string, fallback: Backend[]): Backend[] {
  const value = raw.providers;
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`search.providers in ${origin} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !BACKENDS.includes(entry as Backend)) {
      throw new ConfigError(
        `search.providers[${index}] in ${origin} must be one of ${BACKENDS.join(" | ")}, got ${JSON.stringify(entry)}`,
      );
    }
    return entry as Backend;
  });
}

/**
 * Tool names are validated hard: a duplicate or a builtin collision means a tool
 * gets silently dropped at registration time, with no warning anywhere.
 */
export function resolveToolNames(raw: Raw, origin: string): Record<ToolKey, string> {
  const names: Record<ToolKey, string> = { ...DEFAULT_TOOL_NAMES };
  for (const key of Object.keys(DEFAULT_TOOL_NAMES) as ToolKey[]) {
    const override = str(raw, key, origin, `toolNames.${key}`);
    if (override === undefined) continue;
    if (!TOOL_NAME_PATTERN.test(override)) {
      throw new ConfigError(
        `toolNames.${key} in ${origin} must match ${TOOL_NAME_PATTERN.source}, got ${JSON.stringify(override)}`,
      );
    }
    names[key] = override;
  }

  const seen = new Map<string, ToolKey>();
  for (const key of Object.keys(names) as ToolKey[]) {
    const name = names[key];
    if ((PI_BUILTIN_TOOLS as readonly string[]).includes(name)) {
      throw new ConfigError(
        `toolNames.${key} in ${origin} is "${name}", which shadows a pi builtin tool. ` +
          `Registering it would silently replace pi's own ${name} tool.`,
      );
    }
    const previous = seen.get(name);
    if (previous) {
      throw new ConfigError(
        `toolNames.${previous} and toolNames.${key} in ${origin} are both "${name}". ` +
          `Duplicate tool names are silently dropped by pi — the second registration never takes effect.`,
      );
    }
    seen.set(name, key);
  }
  return names;
}

function optional(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) target[key] = value;
}

export interface LoadOptions {
  cwd: string;
  isProjectTrusted?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(options: LoadOptions): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const homePath = getConfigPath("home", options.cwd);
  const projectPath = getConfigPath("project", options.cwd);

  const home = await readConfigFile(homePath);
  const project =
    options.isProjectTrusted === false ? undefined : await readConfigFile(projectPath);
  const envConfig = readEnvConfig(env);

  const merged = mergeSections(home, project, envConfig);
  const origin = project ? projectPath : homePath;

  const searchRaw = section(merged, "search", origin);
  const codexRaw = section(searchRaw, "codex", origin);
  const xaiRaw = section(searchRaw, "xai", origin);
  const exaRaw = section(searchRaw, "exa", origin);
  const tavilyRaw = section(searchRaw, "tavily", origin);
  const perplexityRaw = section(searchRaw, "perplexity", origin);
  const perplexityRateRaw = section(perplexityRaw, "rateLimit", origin);
  const fetchRaw = section(merged, "fetch", origin);
  const jinaRaw = section(fetchRaw, "jina", origin);
  const domainPolicyRaw = section(fetchRaw, "domainPolicy", origin);
  const ssrfRaw = section(merged, "ssrf", origin);
  const githubRaw = section(merged, "github", origin);
  const pdfRaw = section(merged, "pdf", origin);
  const youtubeRaw = section(merged, "youtube", origin);
  const youtubeGeminiRaw = section(youtubeRaw, "gemini", origin);
  const videoRaw = section(merged, "video", origin);
  const geminiRaw = section(merged, "gemini", origin);
  const toolsRaw = section(merged, "tools", origin);
  const shortcutsRaw = section(merged, "shortcuts", origin);

  const codex: ResolvedConfig["search"]["codex"] = {
    searchContextSize: enumValue(
      codexRaw,
      "searchContextSize",
      origin,
      "search.codex.searchContextSize",
      CONTEXT_SIZES,
      "medium",
    ),
    freshness: enumValue(
      codexRaw,
      "freshness",
      origin,
      "search.codex.freshness",
      FRESHNESS,
      "live",
    ),
  };
  optional(codex, "model", str(codexRaw, "model", origin, "search.codex.model"));
  optional(codex, "baseUrl", str(codexRaw, "baseUrl", origin, "search.codex.baseUrl"));
  optional(
    codex,
    "clientVersion",
    str(codexRaw, "clientVersion", origin, "search.codex.clientVersion"),
  );

  const xai: ResolvedConfig["search"]["xai"] = {};
  optional(
    xai,
    "webSearchModel",
    str(xaiRaw, "webSearchModel", origin, "search.xai.webSearchModel"),
  );
  optional(xai, "xSearchModel", str(xaiRaw, "xSearchModel", origin, "search.xai.xSearchModel"));
  optional(xai, "baseUrl", str(xaiRaw, "baseUrl", origin, "search.xai.baseUrl"));

  const exa: ResolvedConfig["search"]["exa"] = {};
  optional(exa, "mcpUrl", str(exaRaw, "mcpUrl", origin, "search.exa.mcpUrl"));

  const tavily: ResolvedConfig["search"]["tavily"] = {};
  optional(tavily, "apiKey", str(tavilyRaw, "apiKey", origin, "search.tavily.apiKey"));

  const perplexity: ResolvedConfig["search"]["perplexity"] = {
    rateLimit: {
      maxRequests: num(
        perplexityRateRaw,
        "maxRequests",
        origin,
        "search.perplexity.rateLimit.maxRequests",
        10,
        1,
        1000,
      ),
      windowMs: num(
        perplexityRateRaw,
        "windowMs",
        origin,
        "search.perplexity.rateLimit.windowMs",
        60_000,
        1000,
        3_600_000,
      ),
    },
  };
  optional(perplexity, "apiKey", str(perplexityRaw, "apiKey", origin, "search.perplexity.apiKey"));
  optional(perplexity, "model", str(perplexityRaw, "model", origin, "search.perplexity.model"));

  const jina: ResolvedConfig["fetch"]["jina"] = {
    enabled: bool(jinaRaw, "enabled", origin, "fetch.jina.enabled", true),
  };
  optional(jina, "apiKey", str(jinaRaw, "apiKey", origin, "fetch.jina.apiKey"));

  const gemini: ResolvedConfig["gemini"] = {};
  optional(gemini, "apiKey", str(geminiRaw, "apiKey", origin, "gemini.apiKey"));
  optional(gemini, "baseUrl", str(geminiRaw, "baseUrl", origin, "gemini.baseUrl"));

  const resolved: ResolvedConfig = {
    enabled: bool(merged, "enabled", origin, "enabled", true),
    toolNames: resolveToolNames(section(merged, "toolNames", origin), origin),
    tools: {
      search: bool(toolsRaw, "search", origin, "tools.search", true),
      xSearch: bool(toolsRaw, "xSearch", origin, "tools.xSearch", true),
      fetch: bool(toolsRaw, "fetch", origin, "tools.fetch", true),
    },
    search: {
      backend: enumValue(
        searchRaw,
        "backend",
        origin,
        "search.backend",
        ["auto", ...BACKENDS] as const,
        "auto",
      ),
      providers: providerList(searchRaw, origin, [...DEFAULT_PROVIDERS]),
      batchSize: num(
        searchRaw,
        "batchSize",
        origin,
        "search.batchSize",
        5,
        MIN_BATCH_SIZE,
        MAX_BATCH_SIZE,
      ),
      fallbackOn: stringArray(searchRaw, "fallbackOn", origin, "search.fallbackOn", [
        ...DEFAULT_FALLBACK_ON,
      ]) as GleanErrorKind[],
      includeContentLimit: num(
        searchRaw,
        "includeContentLimit",
        origin,
        "search.includeContentLimit",
        5,
        1,
        20,
      ),
      codex,
      xai,
      exa,
      tavily,
      perplexity,
    },
    fetch: {
      timeoutMs: num(fetchRaw, "timeoutMs", origin, "fetch.timeoutMs", 30_000, 1000, 600_000),
      maxInlineChars: num(
        fetchRaw,
        "maxInlineChars",
        origin,
        "fetch.maxInlineChars",
        30_000,
        1000,
        200_000,
      ),
      jina,
      domainPolicy: {
        allow: stringArray(domainPolicyRaw, "allow", origin, "fetch.domainPolicy.allow", []),
        deny: stringArray(domainPolicyRaw, "deny", origin, "fetch.domainPolicy.deny", []),
      },
    },
    ssrf: {
      allowRanges: stringArray(ssrfRaw, "allowRanges", origin, "ssrf.allowRanges", []),
      trustEnvProxy: bool(ssrfRaw, "trustEnvProxy", origin, "ssrf.trustEnvProxy", false),
    },
    github: {
      enabled: bool(githubRaw, "enabled", origin, "github.enabled", true),
      maxRepoSizeMB: num(
        githubRaw,
        "maxRepoSizeMB",
        origin,
        "github.maxRepoSizeMB",
        350,
        1,
        100_000,
      ),
      cloneTimeoutSeconds: num(
        githubRaw,
        "cloneTimeoutSeconds",
        origin,
        "github.cloneTimeoutSeconds",
        30,
        1,
        3600,
      ),
      clonePath: str(githubRaw, "clonePath", origin, "github.clonePath") ?? scratchDir("repos"),
    },
    pdf: {
      maxPages: num(pdfRaw, "maxPages", origin, "pdf.maxPages", 100, 1, 10_000),
      writeFile: bool(pdfRaw, "writeFile", origin, "pdf.writeFile", false),
      // Never $HOME: a generated file has no business in the user's Downloads.
      outputDir: str(pdfRaw, "outputDir", origin, "pdf.outputDir") ?? scratchDir("pdf"),
    },
    youtube: {
      enabled: bool(youtubeRaw, "enabled", origin, "youtube.enabled", true),
      subtitleLangs: stringArray(youtubeRaw, "subtitleLangs", origin, "youtube.subtitleLangs", [
        "en",
      ]),
      preferAutoSubs: bool(youtubeRaw, "preferAutoSubs", origin, "youtube.preferAutoSubs", true),
      gemini: {
        enabled: bool(youtubeGeminiRaw, "enabled", origin, "youtube.gemini.enabled", true),
      },
      ytDlpArgs: stringArray(youtubeRaw, "ytDlpArgs", origin, "youtube.ytDlpArgs", []),
    },
    video: {
      enabled: bool(videoRaw, "enabled", origin, "video.enabled", true),
      maxSizeMB: num(videoRaw, "maxSizeMB", origin, "video.maxSizeMB", 50, 1, 10_000),
      preferredModel:
        str(videoRaw, "preferredModel", origin, "video.preferredModel") ?? "gemini-3-flash-preview",
    },
    gemini,
    shortcuts: {
      activity: str(shortcutsRaw, "activity", origin, "shortcuts.activity") ?? "ctrl+shift+w",
    },
    sources: {},
  };

  if (home) resolved.sources.home = home;
  if (project) resolved.sources.project = project;
  if (Object.keys(envConfig).length > 0) resolved.sources.env = envConfig;

  return resolved;
}

export async function saveConfig(scope: ConfigScope, cwd: string, updates: Raw): Promise<void> {
  const path = getConfigPath(scope, cwd);
  const existing = (await readConfigFile(path)) ?? {};
  const next = mergeSections(existing, updates);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export async function deleteConfig(scope: ConfigScope, cwd: string): Promise<boolean> {
  try {
    await unlink(getConfigPath(scope, cwd));
    return true;
  } catch {
    return false;
  }
}
