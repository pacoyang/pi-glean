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

const CREDENTIAL_HINT: Record<Backend, string> = {
  codex: "/login openai-codex to enable",
  xai: "/login xai to enable",
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
    `Gemini:   ${config.gemini.apiKey ? "configured" : "not configured — video understanding limited to frames"}`,
    `Tools:    ${Object.values(config.toolNames).join(", ")}`,
  ];
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
