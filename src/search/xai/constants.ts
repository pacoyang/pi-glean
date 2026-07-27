export const XAI_PROVIDER_ID = "xai";
export const XAI_API_BASE = "https://api.x.ai/v1";

/** Model backing the general `web_search` tool. */
export const DEFAULT_WEB_SEARCH_MODEL = "grok-4.20-multi-agent";
/** Model backing the `x_search` tool — a different corpus, hence a different model. */
export const DEFAULT_X_SEARCH_MODEL = "grok-4.20-0309-reasoning";

export const SEARCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "pi-glean";

/**
 * Identity of the Grok CLI, required by `cli-chat-proxy.grok.com`.
 *
 * Reverse-engineered protocol constants copied from the official client;
 * inventing our own values would simply fail. The proxy is how a
 * consumer Grok subscription reaches these models — `api.x.ai` bills against
 * API spend, and a subscription-only account has a 0/0 rate limit there.
 */
export const GROK_CLI_VERSION = "0.2.101";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";
export const GROK_CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
