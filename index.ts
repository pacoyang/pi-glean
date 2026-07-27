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
import { registerStatusCommand } from "./src/commands.ts";
import { RateLimiter } from "./src/ratelimit.ts";
import { activityMonitor } from "./src/activity.ts";
import { clearResults, restoreFromSession } from "./src/storage.ts";
import { createXaiOAuth } from "./src/search/xai/auth.ts";
import { XAI_PROVIDER_ID } from "./src/search/xai/constants.ts";
import { buildSearchTool } from "./src/tools/search.ts";
import { buildXSearchTool } from "./src/tools/x-search.ts";

export const VERSION = "0.1.0";

export default async function piGlean(pi: ExtensionAPI): Promise<void> {
  // Loaded once with defaults so the eager tools can be built; refreshed per
  // session where cwd and project trust are known.
  let config: ResolvedConfig = await loadConfig({ cwd: process.cwd() });
  if (!config.enabled) return;

  const rateLimiters = {
    perplexity: new RateLimiter({
      ...config.search.perplexity.rateLimit,
      onUpdate: (info) => activityMonitor.updateRateLimit("perplexity", info),
    }),
  };

  pi.registerProvider(XAI_PROVIDER_ID, { oauth: createXaiOAuth() });

  if (config.tools.search) {
    pi.registerTool(buildSearchTool(pi, { config, rateLimiters }));
  }

  registerStatusCommand(pi, () => config, VERSION);

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

    restoreFromSession(ctx);

    if (!xSearchRegistered && config.tools.xSearch) {
      let hasXai = false;
      try {
        hasXai = Boolean(await ctx.modelRegistry.getApiKeyForProvider(XAI_PROVIDER_ID));
      } catch {
        hasXai = false;
      }
      if (hasXai) {
        pi.registerTool(buildXSearchTool(pi, config));
        xSearchRegistered = true;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => onSessionChange(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionChange(ctx));
  pi.on("session_shutdown", async () => {
    clearResults();
    activityMonitor.clear();
  });
}
