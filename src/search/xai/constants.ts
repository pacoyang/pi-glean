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
/** The public API. Requires either API credit or an account on unified billing. */
export const XAI_API_BASE = "https://api.x.ai/v1";

/**
 * The Grok CLI proxy — the default, and the route a subscription is entitled to.
 *
 * Both hosts serve the same Responses API and both run the search tools with a
 * grok-build credential, so the choice is about *entitlement*, not capability.
 * The proxy is what the official Grok CLI uses, and it is the path a Grok
 * subscription is provisioned for. `api.x.ai` additionally
 * worked on a test account, but only because that account was on unified
 * billing (`isUnifiedBillingUser`, usage booked against the `Api` product) —
 * a subscription-only account has no reason to be entitled there, and gets the
 * same `429 resource-exhausted` at a 0/0 team limit that a plain `xai` token
 * gets everywhere.
 *
 * The proxy authenticates the client as well as the token: without the identity
 * headers in responses.ts it accepts the connection and never answers, which
 * shows up as a five-minute stall rather than an error.
 */
export const GROK_CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_VERSION = "0.2.101";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_TOKEN_AUTH = "xai-grok-cli";

/**
 * The host a credential is entitled to reach.
 *
 * The two are not interchangeable, and which one is right follows from the
 * credential rather than from configuration: a subscription is provisioned for
 * the proxy, while an API key is an `api.x.ai` credential and is not
 * recognised by the proxy at all. Deriving it means neither kind of user has to
 * know this exists; `search.xai.baseUrl` still overrides.
 */
export function defaultBaseUrlFor(providerId: string): string {
  return providerId === GROK_BUILD_PROVIDER_ID ? GROK_CLI_PROXY_BASE : XAI_API_BASE;
}

/** Model backing the general `web_search` tool. */
export const DEFAULT_WEB_SEARCH_MODEL = "grok-4.20-multi-agent";
/** Model backing the `x_search` tool — a different corpus, hence a different model. */
export const DEFAULT_X_SEARCH_MODEL = "grok-4.20-0309-reasoning";

export const SEARCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "pi-glean";
