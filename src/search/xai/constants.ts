export const XAI_PROVIDER_ID = "xai";
export const XAI_API_BASE = "https://api.x.ai/v1";

/** Model backing the general `web_search` tool. */
export const DEFAULT_WEB_SEARCH_MODEL = "grok-4.20-multi-agent";
/** Model backing the `x_search` tool — a different corpus, hence a different model. */
export const DEFAULT_X_SEARCH_MODEL = "grok-4.20-0309-reasoning";

export const SEARCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "pi-glean";
