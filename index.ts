/**
 * pi-glean — zero-config web search and URL fetching for pi.
 *
 * Registration timing is deliberate:
 *
 *   glean_search / glean_fetch / glean_get_content register at load time. They
 *   work with no credential at all (exa needs none, fetching needs none), so
 *   they belong in the first system prompt.
 *
 *   glean_x_search registers from `session_start`, and only once xAI auth is
 *   confirmed — `registerTool` runs before any `ctx` exists, so this is the
 *   earliest point the check is possible. Registering it unconditionally would
 *   give every user without an xAI subscription a tool that can only fail.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrustedContext, loadConfig, type ResolvedConfig } from "./src/config.ts";
import { registerResultsCommand, registerStatusCommand } from "./src/commands.ts";
import { registerActivityWidget } from "./src/widget.ts";
import { clearCloneCache } from "./src/github/extract.ts";
import { RateLimiter } from "./src/ratelimit.ts";
import { activityMonitor } from "./src/activity.ts";
import { clearResults, restoreFromSession } from "./src/storage.ts";
import { XAI_LOGIN_VARIANTS, createXaiOAuth, resolveXaiCredential } from "./src/search/xai/auth.ts";

import { buildFetchTool } from "./src/tools/fetch.ts";
import { buildGetContentTool } from "./src/tools/get-content.ts";
import { abortPendingFetches, markSessionActive } from "./src/tools/prefetch.ts";
import { buildSearchTool } from "./src/tools/search.ts";
import { buildXSearchTool } from "./src/tools/x-search.ts";

export const VERSION = "0.1.0";

export default async function piGlean(pi: ExtensionAPI): Promise<void> {
  // The project layer is deliberately excluded here: extensions load before any
  // session exists, so project trust is not yet knowable, and `.pi/pi-glean.json`
  // can set `search.codex.baseUrl` — which would send the user's ChatGPT
  // credential to whatever host an untrusted repository names. session_start
  // reloads with the real cwd and trust decision, and every tool reads the
  // config live, so a trusted project's settings take effect there.
  let config: ResolvedConfig = await loadConfig({
    cwd: process.cwd(),
    isProjectTrusted: false,
  });
  if (!config.enabled) return;

  const rateLimiters = {
    perplexity: new RateLimiter({
      ...config.search.perplexity.rateLimit,
      onUpdate: (info) => activityMonitor.updateRateLimit("perplexity", info),
    }),
    // Jina's free tier is 20 requests a minute; wait rather than fail.
    jina: new RateLimiter({
      maxRequests: config.fetch.jina.apiKey ? 500 : 20,
      windowMs: 60_000,
      onUpdate: (info) => activityMonitor.updateRateLimit("jina", info),
    }),
  };

  // Only the subscription grant. pi resolves XAI_API_KEY into its own built-in
  // `xai` slot without help, and the OAuth grant for that slot cannot search.
  // registerProvider upserts, so sharing a slot with another extension is safe.
  for (const variant of XAI_LOGIN_VARIANTS) {
    pi.registerProvider(variant.providerId, { oauth: createXaiOAuth(variant) });
  }

  const getConfig = (): ResolvedConfig => config;

  if (config.tools.search) {
    pi.registerTool(buildSearchTool(pi, { getConfig, rateLimiters }));
  }
  if (config.tools.fetch) {
    pi.registerTool(buildFetchTool(pi, { getConfig, rateLimiters }));
  }
  if (config.tools.search || config.tools.fetch) {
    pi.registerTool(buildGetContentTool(config));
  }

  registerStatusCommand(pi, getConfig, VERSION);
  registerResultsCommand(pi, getConfig);
  registerActivityWidget(pi, config.shortcuts.activity);

  let xSearchRegistered = false;

  const onSessionChange = async (ctx: ExtensionContext): Promise<void> => {
    try {
      config = await loadConfig({ cwd: ctx.cwd, isProjectTrusted: isProjectTrustedContext(ctx) });
    } catch (error) {
      // A broken config must not take the whole extension down; keep the last
      // good one and tell the user what to fix.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`pi-glean config error: ${message}`, "error");
      else console.error(`pi-glean config error: ${message}`);
    }

    markSessionActive(true);
    // Clones belong to the branch that made them; a tree jump invalidates them.
    clearCloneCache();
    restoreFromSession(ctx);

    if (!xSearchRegistered && config.tools.xSearch) {
      let hasXai = false;
      try {
        hasXai = (await resolveXaiCredential(ctx.modelRegistry)) !== undefined;
      } catch {
        hasXai = false;
      }
      if (hasXai) {
        pi.registerTool(buildXSearchTool(pi, getConfig));
        xSearchRegistered = true;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => onSessionChange(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionChange(ctx));
  pi.on("session_shutdown", async () => {
    // Order matters: stop in-flight prefetches before clearing what they write
    // into, so a late completion cannot resurrect a dead session's records.
    markSessionActive(false);
    abortPendingFetches();
    clearResults();
    clearCloneCache();
    activityMonitor.clear();
  });
}
