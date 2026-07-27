/**
 * `/glean-status` — read-only diagnostics.
 *
 * Subscriptions and API keys are optional *enhancements*, not missing
 * requirements, so unconfigured backends render as `– optional` rather than a
 * failure marker. exa is listed first precisely because it is the one that
 * always works: a fresh install with nothing configured is a working install,
 * and the output should say so.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getConfigPath, type ResolvedConfig } from "./config.ts";
import { existsSync } from "node:fs";
import { PROVIDERS, type ModelRegistryLike, type ProviderContext } from "./search/providers.ts";
import type { Backend } from "./search/citations.ts";
import { detectBinary, installHint, type Binary } from "./platform.ts";
import { deleteResult, getAllResults, type StoredSearchData } from "./storage.ts";
import { formatAge, truncate } from "./format.ts";
import { hasCredentialSource } from "./credentials.ts";

const CREDENTIAL_HINT: Record<Backend, string> = {
  codex: "/login openai-codex to enable",
  xai: "/login grok-build, or set XAI_API_KEY",
  tavily: "set TAVILY_API_KEY",
  perplexity: "set PERPLEXITY_API_KEY",
  exa: "no credentials needed",
};

function describeKind(backend: Backend): string {
  return PROVIDERS[backend].synthesized ? "synthesized answer" : "source text";
}

async function backendLines(config: ResolvedConfig, ctx: ProviderContext): Promise<string[]> {
  const order = config.search.providers;
  const statuses = await Promise.all(
    order.map(async (backend) => {
      let ready = false;
      try {
        ready = await PROVIDERS[backend].isAvailable(ctx);
      } catch {
        ready = false;
      }
      return { backend, ready };
    }),
  );

  // Ready backends first so a working install does not open with a wall of dashes.
  statuses.sort((a, b) => Number(b.ready) - Number(a.ready));

  return statuses.map(({ backend, ready }) => {
    const marker = ready ? "✓ ready" : "– optional";
    const detail = ready
      ? backend === "exa"
        ? "no credentials needed"
        : "configured"
      : CREDENTIAL_HINT[backend];
    return `  ${backend.padEnd(12)} ${marker} · ${detail}`.padEnd(52) + describeKind(backend);
  });
}

async function binaryLine(): Promise<string> {
  const wanted: Binary[] = ["git", "gh", "ffmpeg", "ffprobe", "yt-dlp"];
  const parts = await Promise.all(
    wanted.map(async (binary) => {
      const present = await detectBinary(binary);
      return present ? `${binary} ✓` : `${binary} ✗ (${installHint(binary)})`;
    }),
  );
  return `Binaries: ${parts.join("  ")}`;
}

export async function renderStatus(
  config: ResolvedConfig,
  ctx: ProviderContext,
  cwd: string,
  version: string,
): Promise<string> {
  const homePath = getConfigPath("home", cwd);
  const projectPath = getConfigPath("project", cwd);

  const lines = [
    `pi-glean ${version}`,
    `Config:   ${homePath} (${existsSync(homePath) ? "found" : "not found"})`,
    `          ${projectPath} (${existsSync(projectPath) ? "found" : "not found"})`,
    `Search:   backend=${config.search.backend}  order: ${config.search.providers.join(" → ")}`,
    ...(await backendLines(config, ctx)),
    `Fetch:    jina=${config.fetch.jina.enabled ? "enabled" : "disabled"}` +
      `${config.fetch.jina.enabled && !config.fetch.jina.apiKey ? " (no API key — 20 RPM)" : ""}` +
      `  ssrf=on  domainPolicy: ${config.fetch.domainPolicy.allow.length} allow / ${config.fetch.domainPolicy.deny.length} deny`,
    await binaryLine(),
    `Gemini:   ${
      hasCredentialSource({
        provider: "gemini",
        configuredValue: config.gemini.apiKey,
        environmentValue: process.env.GEMINI_API_KEY,
      })
        ? "configured"
        : "not configured — video understanding limited to frames"
    }`,
    `Tools:    ${Object.values(config.toolNames).join(", ")}`,
  ];
  return lines.join("\n");
}

/**
 * `/glean-search` — browse what this session has stored.
 *
 * Named with the extension prefix rather than a bare `/search`: pi suffixes
 * clashing command names (`/search:1`), which works but is confusing.
 */
export function registerResultsCommand(pi: ExtensionAPI, getConfig: () => ResolvedConfig): void {
  pi.registerCommand("glean-search", {
    description: "Browse, inspect and delete stored pi-glean results",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const results = getAllResults();
      if (results.length === 0) {
        ctx.ui.notify("No stored pi-glean results in this session.", "info");
        return;
      }
      if (!ctx.hasUI) {
        console.log(results.map((result) => summarize(result)).join("\n"));
        return;
      }

      const options = results.map((result) => summarize(result));
      const choice = await ctx.ui.select("Stored results", options);
      if (!choice) return;

      const id = choice.match(/^\[([a-z0-9]+)]/)?.[1];
      // No id parsed means the label was not one we rendered; select nothing.
      const selected = id ? results.find((result) => result.id.startsWith(id)) : undefined;
      if (!selected) return;

      const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, [
        "View details",
        "Delete",
      ]);
      if (action === "Delete") {
        deleteResult(selected.id);
        ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
        return;
      }
      if (action === "View details") {
        ctx.ui.notify(details(selected, getConfig()), "info");
      }
    },
  });
}

function summarize(result: StoredSearchData): string {
  const age = formatAge(Date.now() - result.timestamp);
  const id = result.id.slice(0, 6);
  if (result.type === "search" && result.queries?.length) {
    const first = result.queries[0]!.query;
    const more = result.queries.length > 1 ? ` +${result.queries.length - 1}` : "";
    return `[${id}] "${truncate(first, 40)}"${more} — ${age}`;
  }
  if (result.type === "fetch" && result.urls?.length) {
    return `[${id}] ${result.urls.length} URL(s) fetched — ${age}`;
  }
  return `[${id}] ${result.type} — ${age}`;
}

function details(result: StoredSearchData, config: ResolvedConfig): string {
  const lines = [
    `ID: ${result.id}`,
    `Type: ${result.type}`,
    `Age: ${formatAge(Date.now() - result.timestamp)}`,
    "",
  ];
  for (const query of result.queries?.slice(0, 10) ?? []) {
    lines.push(`- "${query.query}" (${query.backend}, ${query.citations.length} sources)`);
  }
  for (const entry of result.urls?.slice(0, 10) ?? []) {
    lines.push(`- ${truncate(entry.url, 60)} (${entry.error ?? `${entry.content.length} chars`})`);
  }
  const total = (result.queries?.length ?? 0) + (result.urls?.length ?? 0);
  if (total > 10) lines.push(`… and ${total - 10} more`);
  lines.push("", `Retrieve with ${config.toolNames.getContent}({ responseId: "${result.id}" })`);
  return lines.join("\n");
}

export function registerStatusCommand(
  pi: ExtensionAPI,
  getConfig: () => ResolvedConfig,
  version: string,
): void {
  pi.registerCommand("glean-status", {
    description: "Show pi-glean backends, credentials and binary availability",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const config = getConfig();
      const providerCtx: ProviderContext = {
        config,
        modelRegistry: ctx.modelRegistry as unknown as ModelRegistryLike,
      };
      const text = await renderStatus(config, providerCtx, ctx.cwd, version);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
