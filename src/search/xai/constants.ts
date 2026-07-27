export const XAI_PROVIDER_ID = "xai";

/**
 * The credential slot a Grok subscription actually lands in.
 *
 * `/login xai` and `/login grok-build` are different OAuth grants against the
 * same client. The grok-build grant additionally carries
 * `conversations:read`/`conversations:write`, and only that token is allowed to
 * run the Responses search tools: with the plain `xai` token every model
 * returns `429 resource-exhausted` at a team limit of 0/0, because those calls
 * bill against xAI API spend rather than the subscription.
 *
 * Only present once that login has been completed — hence a preference,
 * not a requirement.
 */
export const GROK_BUILD_PROVIDER_ID = "grok-build";

/** Checked in order; the first credential found wins. */
export const XAI_CREDENTIAL_PROVIDERS = [GROK_BUILD_PROVIDER_ID, XAI_PROVIDER_ID] as const;
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
