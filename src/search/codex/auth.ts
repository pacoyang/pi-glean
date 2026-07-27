/**
 * Resolves the ChatGPT account id that must accompany every Codex request.
 *
 * pi changed how stored credentials are exposed around 0.80.8: newer builds
 * export `readStoredCredential`, older ones only had `modelRegistry.authStorage`.
 * Both are probed by duck-typing rather than by version check — this is the one
 * place pi-glean forks on pi's version, and it is why CI runs a two-entry
 * version matrix.
 *
 * If neither yields an id, fall back to the JWT's own account claim.
 */

import * as piCodingAgent from "@earendil-works/pi-coding-agent";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

interface StoredCredential {
  type?: unknown;
  accountId?: unknown;
}

interface LegacyModelRegistry {
  authStorage?: { get(provider: string): StoredCredential | undefined };
}

export type StoredCredentialReader = (provider: string) => StoredCredential | undefined;

function publicCredentialReader(): StoredCredentialReader | undefined {
  return (piCodingAgent as { readStoredCredential?: StoredCredentialReader }).readStoredCredential;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf-8",
    );
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads `https://api.openai.com/auth`.`chatgpt_account_id` out of the access token. */
export function extractAccountIdFromToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

export function isCodexJwt(token: string): boolean {
  return extractAccountIdFromToken(token) !== undefined;
}

export function resolveAccountId(
  token: string,
  modelRegistry: object,
  readStoredCredential: StoredCredentialReader | null = publicCredentialReader() ?? null,
): string | undefined {
  const credential = readStoredCredential
    ? readStoredCredential(OPENAI_CODEX_PROVIDER)
    : (modelRegistry as LegacyModelRegistry).authStorage?.get(OPENAI_CODEX_PROVIDER);
  if (credential?.type === "oauth" && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) return accountId;
  }
  return extractAccountIdFromToken(token);
}
