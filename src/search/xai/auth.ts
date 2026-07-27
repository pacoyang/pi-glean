/**
 * xAI OAuth device-code flow.
 *
 * Registered with pi so `/login grok-build` works; pi then owns storage and refresh.
 * pi-glean never reads auth.json itself.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * The two grants xAI issues against this client, and the reason both exist.
 *
 * They differ only in scope and referrer, but that difference decides whether
 * the account can run the Responses search tools at all. Verified live: with a
 * `grok-build` token a search reports 4-12 server-side tool calls and returns
 * sourced results; with an `xai` token every model returns
 * `429 resource-exhausted` at a team limit of 0/0, because those calls bill
 * against xAI API spend rather than a Grok subscription.
 *
 * Both are registered so a subscription and an API-credit account each have a
 * working path, and so that a credential stored by another extension using the
 * same slots is picked up rather than duplicated.
 */
interface XaiOAuthVariant {
  providerId: string;
  name: string;
  scope: string;
  referrer: string;
  /** Host this credential is entitled to reach. */
  baseUrl: string;
}

const BASE_SCOPE = "openid profile email offline_access grok-cli:access api:access";

const GROK_BUILD_VARIANT: XaiOAuthVariant = {
  providerId: "grok-build",
  name: "xAI (Grok subscription)",
  // The conversations scopes are what unlock the search tools.
  scope: `${BASE_SCOPE} conversations:read conversations:write`,
  referrer: "grok-build",
  // The Grok CLI proxy, which is what a subscription is provisioned for.
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
};

/**
 * pi's built-in xAI slot, where `XAI_API_KEY` lands.
 *
 * Read but never offered as a login. The device grant for this slot omits the
 * conversations scopes, so it cannot run the search tools — advertising it
 * would hand people a credential that fails for a reason they cannot see.
 */
export const XAI_API_VARIANT: XaiOAuthVariant = {
  providerId: "xai",
  name: "xAI (API key)",
  scope: BASE_SCOPE,
  referrer: "pi",
  // The public API. An XAI_API_KEY is a credential for this host and is not
  // recognised by the proxy, so the two are not interchangeable.
  baseUrl: "https://api.x.ai/v1",
};

/** Credential slots, most capable first. */
export const XAI_VARIANTS = [GROK_BUILD_VARIANT, XAI_API_VARIANT] as const;

/** The only grant worth offering: the other cannot search. */
export const XAI_LOGIN_VARIANTS = [GROK_BUILD_VARIANT] as const;

/** The slice of pi's registry this needs; keeps auth.ts free of provider types. */
export interface ApiKeyLookup {
  getApiKeyForProvider(provider: string): Promise<string | undefined> | string | undefined;
}

export interface XaiCredential {
  token: string;
  /** Which slot it came from — this decides the endpoint. */
  providerId: string;
}

/**
 * First xAI credential available, preferring the subscription grant.
 *
 * The slot is returned alongside the token because the two grants are entitled
 * to different hosts.
 */
export async function resolveXaiCredential(
  registry: ApiKeyLookup,
): Promise<XaiCredential | undefined> {
  for (const { providerId } of XAI_VARIANTS) {
    let token: string | undefined;
    try {
      token = (await registry.getApiKeyForProvider(providerId)) || undefined;
    } catch {
      continue;
    }
    if (token) return { token, providerId };
  }
  return undefined;
}

/** Endpoint for a credential, or the public API for an unknown slot. */
export function baseUrlForProvider(providerId: string): string {
  return (
    XAI_VARIANTS.find((variant) => variant.providerId === providerId)?.baseUrl ??
    XAI_API_VARIANT.baseUrl
  );
}
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
/** Refresh early so a request never starts with a token about to expire. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

type JsonObject = Record<string, unknown>;

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

function positiveNumber(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

/** The verification URI is shown to the user and opened; refuse anything but https. */
function validateVerificationUri(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal,
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
  }
  return {
    ok: response.ok,
    status: response.status,
    body:
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {},
  };
}

function requestFailure(action: string, response: { status: number; body: JsonObject }): Error {
  const error = typeof response.body.error === "string" ? response.body.error : undefined;
  const description =
    typeof response.body.error_description === "string"
      ? response.body.error_description
      : undefined;
  const detail = [error, description].filter(Boolean).join(": ");
  return new Error(
    `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

function credentialsFromTokenResponse(
  body: JsonObject,
  previousRefresh?: string,
): OAuthCredentials {
  const access = requiredString(body, "access_token");
  // Refresh tokens are sometimes omitted on refresh; keep the one we have.
  const refresh =
    body.refresh_token === undefined && previousRefresh
      ? previousRefresh
      : requiredString(body, "refresh_token");
  const lifetime =
    body.expires_in === undefined
      ? DEFAULT_TOKEN_LIFETIME_SECONDS
      : positiveNumber(body, "expires_in");
  return { access, refresh, expires: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

export function createXaiOAuth(
  variant: XaiOAuthVariant = GROK_BUILD_VARIANT,
  fetchImpl: typeof fetch = fetch,
) {
  return {
    name: variant.name,

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const device = await postForm(
        fetchImpl,
        DEVICE_CODE_URL,
        { client_id: CLIENT_ID, scope: variant.scope, referrer: variant.referrer },
        callbacks.signal,
      );
      if (!device.ok) throw requestFailure("device authorization", device);

      const deviceCode = requiredString(device.body, "device_code");
      const userCode = requiredString(device.body, "user_code");
      const verificationUri = validateVerificationUri(
        requiredString(device.body, "verification_uri"),
      );
      const complete = device.body.verification_uri_complete;
      const expiresInSeconds = positiveNumber(device.body, "expires_in");
      let intervalSeconds =
        typeof device.body.interval === "number" && device.body.interval > 0
          ? device.body.interval
          : 5;

      callbacks.onDeviceCode({
        userCode,
        verificationUri:
          typeof complete === "string" && complete.length > 0
            ? validateVerificationUri(complete)
            : verificationUri,
        intervalSeconds,
        expiresInSeconds,
      });

      const deadline = Date.now() + expiresInSeconds * 1000;
      while (Date.now() < deadline) {
        await wait(intervalSeconds * 1000, callbacks.signal);
        const token = await postForm(
          fetchImpl,
          TOKEN_URL,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: CLIENT_ID,
            device_code: deviceCode,
          },
          callbacks.signal,
        );
        if (token.ok) return credentialsFromTokenResponse(token.body);

        const error = token.body.error;
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          intervalSeconds += 5;
          continue;
        }
        if (error === "access_denied" || error === "authorization_denied") {
          throw new Error("xAI device authorization was denied");
        }
        if (error === "expired_token") throw new Error("xAI device code expired");
        throw requestFailure("device token polling", token);
      }
      throw new Error("xAI device code expired");
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const response = await postForm(fetchImpl, TOKEN_URL, {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: credentials.refresh,
      });
      if (!response.ok) throw requestFailure("token refresh", response);
      return credentialsFromTokenResponse(response.body, credentials.refresh);
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}
