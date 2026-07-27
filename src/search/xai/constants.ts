/**
 * Grok CLI identity, required by `cli-chat-proxy.grok.com`.
 *
 * Reverse-engineered protocol constants, copied from the official client: the
 * proxy authenticates the caller as well as the token, and without these it
 * accepts the connection and never answers — a five-minute stall rather than an
 * error.
 */
export const GROK_CLI_PROXY_HOST = "cli-chat-proxy.grok.com";
export const GROK_CLI_VERSION = "0.2.101";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";

/** Model backing the general `web_search` tool. */
export const DEFAULT_WEB_SEARCH_MODEL = "grok-4.20-multi-agent";
/** Model backing the `x_search` tool — a different corpus, hence a different model. */
export const DEFAULT_X_SEARCH_MODEL = "grok-4.20-0309-reasoning";

export const SEARCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "pi-glean";
