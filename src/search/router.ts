/**
 * Backend selection for `glean_search`.
 *
 * `auto` walks `search.providers` in order, skipping backends with no
 * credential, and moves to the next one *only* when the failure is of a kind
 * where another backend could plausibly succeed (`search.fallbackOn`).
 *
 * That condition matters: `auth`, `invalid-request` and `config` failures would
 * fail identically everywhere, so falling through on them would replace a
 * precise, fixable error with a generic "everything failed" at the end.
 *
 * The default order puts subscriptions first — their quota is already paid for —
 * with exa last, since it never fails and would otherwise starve every backend
 * behind it.
 */

import { GleanError, classifyError, type GleanErrorKind } from "../errors.ts";
import type { Backend, SearchAnswer } from "./citations.ts";
import { PROVIDERS, type ProviderContext, type SearchParams } from "./providers.ts";

export interface RouteResult extends SearchAnswer {
  /** Backends tried and skipped before this one answered. */
  attempts: AttemptRecord[];
}

export interface AttemptRecord {
  backend: Backend;
  outcome: "skipped" | "failed" | "ok";
  kind?: GleanErrorKind;
  message?: string;
}

function describe(attempts: AttemptRecord[]): string {
  return attempts
    .map((attempt) => {
      if (attempt.outcome === "skipped") return `  - ${attempt.backend}: not configured`;
      return `  - ${attempt.backend} [${attempt.kind}]: ${attempt.message}`;
    })
    .join("\n");
}

/** Actionable guidance when nothing was even available to try. */
function noBackendsError(attempts: AttemptRecord[]): GleanError {
  return new GleanError("config", "No search backend is available.", {
    source: "router",
    hint:
      "exa needs no credentials and is enabled by default — check that it is present in " +
      "search.providers. For synthesized answers, run `/login openai-codex` or `/login grok-build`, " +
      "or set TAVILY_API_KEY / PERPLEXITY_API_KEY.\n" +
      describe(attempts),
  });
}

export interface RouteOptions extends SearchParams {
  /** Explicit backend, or `auto` to walk the configured order. */
  backend?: Backend | "auto";
}

export async function routeSearch(
  options: RouteOptions,
  ctx: ProviderContext,
): Promise<RouteResult> {
  const requested = options.backend ?? ctx.config.search.backend;
  const order: Backend[] = requested === "auto" ? [...ctx.config.search.providers] : [requested];
  const fallbackOn = new Set<GleanErrorKind>(ctx.config.search.fallbackOn);
  const attempts: AttemptRecord[] = [];

  for (const backend of order) {
    const provider = PROVIDERS[backend];

    // An explicit backend is never skipped: the user asked for it by name, so a
    // missing credential must be reported rather than silently ignored.
    if (requested === "auto") {
      let available = false;
      try {
        available = await provider.isAvailable(ctx);
      } catch {
        available = false;
      }
      if (!available) {
        attempts.push({ backend, outcome: "skipped" });
        continue;
      }
    }

    try {
      const result = await provider.search(options, ctx);
      attempts.push({ backend, outcome: "ok" });
      return { ...result, attempts };
    } catch (error) {
      const classified = classifyError(error, backend);
      attempts.push({
        backend,
        outcome: "failed",
        kind: classified.kind,
        message: classified.message,
      });

      // An abort is the caller's decision, not a backend failure.
      if (classified.kind === "aborted") throw classified;

      const isLast = backend === order[order.length - 1];
      if (!fallbackOn.has(classified.kind) || isLast) {
        if (requested !== "auto" || attempts.filter((a) => a.outcome === "failed").length === 1) {
          throw classified;
        }
        throw new GleanError(
          classified.kind,
          `All search backends failed.\n${describe(attempts)}`,
          {
            source: "router",
            cause: classified,
          },
        );
      }
    }
  }

  throw noBackendsError(attempts);
}
