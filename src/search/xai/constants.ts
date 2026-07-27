export const XAI_PROVIDER_ID = "xai";

export const GROK_BUILD_PROVIDER_ID = "grok-build";

/**
 * Credential slots, most capable first.
 *
 * Both are registered by this extension, so either login works on its own. The
 * order matters because an account may hold both: the grok-build grant is the
 * one that can run the search tools. See auth.ts for why.
 */
export const XAI_CREDENTIAL_PROVIDERS = [GROK_BUILD_PROVIDER_ID, XAI_PROVIDER_ID] as const;
export const XAI_API_BASE = "https://api.x.ai/v1";

/**
 * The Grok CLI proxy, an alternative host for the same Responses API.
 *
 * Not the default: `api.x.ai` serves every model, the proxy only some. It is
 * supported because the official Grok CLI uses it, and because it
 * authenticates the *client* as well as the token — without the
 * identity headers below it accepts the connection and never answers, which
 * surfaces as a five-minute hang rather than an error.
 *
 * Both hosts work with a grok-build credential and both report usage cost, so
 * this is a routing preference rather than a billing one.
 */
export const GROK_CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_VERSION = "0.2.101";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";

/** Model backing the general `web_search` tool. */
export const DEFAULT_WEB_SEARCH_MODEL = "grok-4.20-multi-agent";
/** Model backing the `x_search` tool — a different corpus, hence a different model. */
export const DEFAULT_X_SEARCH_MODEL = "grok-4.20-0309-reasoning";

export const SEARCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "pi-glean";
