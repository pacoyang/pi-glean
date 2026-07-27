import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-glean — zero-config web search and URL fetching for pi.
 *
 * Tool registration lands in later phases:
 *   glean_search / glean_fetch / glean_get_content register eagerly (they work
 *   without any credential — exa needs none and fetching needs none), while
 *   glean_x_search registers from `session_start` only once xAI auth is
 *   confirmed, so users without an xAI subscription never see a tool that can
 *   only fail.
 */
export default function piGlean(_pi: ExtensionAPI): void {
  // Phase 0: scaffolding only.
}
