/**
 * Model discovery for the Codex backend.
 *
 * The set of models a ChatGPT subscription may use is server-controlled and
 * changes without notice, so the model is discovered rather than hardcoded.
 * The result is cached for the process: a search should not pay for a model
 * listing on every call.
 */

import { GleanError, classifyHttpStatus, formatHttpErrorBody } from "../../errors.ts";
import type { FetchLike } from "./cookies.ts";
import { createTransport } from "./transport.ts";

export interface CodexModel {
  id: string;
  name?: string;
  isDefault?: boolean;
}

export interface FetchModelsOptions {
  token: string;
  accountId: string;
  baseUrl?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export const DEFAULT_CLIENT_VERSION = "1.0.0";

export async function fetchCodexModels(options: FetchModelsOptions): Promise<CodexModel[]> {
  const transportOptions: Parameters<typeof createTransport>[0] = {
    token: options.token,
    accountId: options.accountId,
  };
  if (options.baseUrl !== undefined) transportOptions.baseUrl = options.baseUrl;
  if (options.clientVersion !== undefined) transportOptions.clientVersion = options.clientVersion;
  if (options.fetchImpl !== undefined) transportOptions.fetchImpl = options.fetchImpl;
  const transport = createTransport(transportOptions);

  const endpoint = new URL(transport.endpoint("models"));
  endpoint.searchParams.set("client_version", options.clientVersion ?? DEFAULT_CLIENT_VERSION);

  const response = await transport.fetch(endpoint.toString(), {
    headers: transport.buildHeaders("application/json"),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = formatHttpErrorBody(await response.text());
    throw new GleanError(
      classifyHttpStatus(response.status),
      `Codex models request failed: HTTP ${response.status}: ${body}`,
      { status: response.status, source: "codex" },
    );
  }

  const data = (await response.json()) as {
    models?: Array<{
      slug?: string;
      id?: string;
      model?: string;
      display_name?: string;
      is_default?: boolean;
    }>;
  };

  return (data.models ?? [])
    .map((model) => {
      const entry: CodexModel = { id: model.slug ?? model.id ?? model.model ?? "" };
      if (model.display_name !== undefined) entry.name = model.display_name;
      if (model.is_default !== undefined) entry.isDefault = model.is_default;
      return entry;
    })
    .filter((model) => model.id.length > 0);
}

export function selectDefaultModel(models: CodexModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

let cached: { key: string; model: string } | undefined;

/** Resolves the model to use, preferring an explicit config value. */
export async function resolveCodexModel(
  options: FetchModelsOptions & { configuredModel?: string },
): Promise<string> {
  if (options.configuredModel) return options.configuredModel;

  const key = `${options.accountId}:${options.baseUrl ?? ""}`;
  if (cached?.key === key) return cached.model;

  const models = await fetchCodexModels(options);
  const model = selectDefaultModel(models);
  if (!model) {
    throw new GleanError("invalid-response", "Codex returned no usable models", {
      source: "codex",
      hint: "Set search.codex.model in pi-glean.json to pin one explicitly.",
    });
  }
  cached = { key, model };
  return model;
}
