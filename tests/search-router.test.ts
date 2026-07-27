import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GleanError } from "../src/errors.ts";
import type { Backend } from "../src/search/citations.ts";
import { PROVIDERS, type ProviderDef } from "../src/search/providers.ts";
import { routeSearch } from "../src/search/router.ts";
import { providerContext, testConfig } from "./helpers/fixtures.ts";

/** Swap the real provider table for stubs, restoring it afterwards. */
function withProviders(
  stubs: Partial<Record<Backend, Partial<ProviderDef>>>,
  run: () => Promise<void>,
): Promise<void> {
  const originals = { ...PROVIDERS };
  for (const [backend, stub] of Object.entries(stubs) as [Backend, Partial<ProviderDef>][]) {
    PROVIDERS[backend] = { ...originals[backend], ...stub };
  }
  return run().finally(() => {
    for (const backend of Object.keys(originals) as Backend[]) {
      PROVIDERS[backend] = originals[backend];
    }
  });
}

function answering(backend: Backend): Partial<ProviderDef> {
  return {
    isAvailable: async () => true,
    search: async (params) => ({
      backend,
      query: params.query,
      answer: `answer from ${backend}`,
      citations: [],
      searchCalls: [],
      raw: {},
    }),
  };
}

function failing(kind: GleanError["kind"]): Partial<ProviderDef> {
  return {
    isAvailable: async () => true,
    search: async () => {
      throw new GleanError(kind, `${kind} failure`);
    },
  };
}

const unavailable: Partial<ProviderDef> = { isAvailable: async () => false };

describe("auto ordering", () => {
  it("uses the first available backend in configured order", async () => {
    await withProviders({ codex: answering("codex"), xai: answering("xai") }, async () => {
      const result = await routeSearch({ query: "q" }, providerContext());
      assert.equal(result.backend, "codex");
    });
  });

  it("skips backends with no credential instead of failing", async () => {
    await withProviders(
      {
        codex: unavailable,
        xai: unavailable,
        tavily: unavailable,
        perplexity: unavailable,
        exa: answering("exa"),
      },
      async () => {
        const result = await routeSearch({ query: "q" }, providerContext());
        assert.equal(result.backend, "exa");
        assert.deepEqual(
          result.attempts.filter((a) => a.outcome === "skipped").map((a) => a.backend),
          ["codex", "xai", "tavily", "perplexity"],
        );
      },
    );
  });

  it("honours a custom provider order", async () => {
    const config = testConfig();
    config.search.providers = ["exa", "codex"];
    await withProviders({ codex: answering("codex"), exa: answering("exa") }, async () => {
      const result = await routeSearch({ query: "q" }, providerContext({ config }));
      assert.equal(result.backend, "exa");
    });
  });
});

describe("conditional fallback", () => {
  it("falls through on a quota failure", async () => {
    await withProviders({ codex: failing("quota"), xai: answering("xai") }, async () => {
      const result = await routeSearch({ query: "q" }, providerContext());
      assert.equal(result.backend, "xai");
      assert.equal(result.attempts[0]?.kind, "quota");
    });
  });

  it("falls through on transient and network failures", async () => {
    for (const kind of ["transient", "network"] as const) {
      await withProviders({ codex: failing(kind), xai: answering("xai") }, async () => {
        const result = await routeSearch({ query: "q" }, providerContext());
        assert.equal(result.backend, "xai", `kind=${kind}`);
      });
    }
  });

  it("does NOT fall through on auth, invalid-request or config", async () => {
    // These would fail identically on every backend; masking them behind a
    // fallback would replace a fixable error with a generic one.
    for (const kind of ["auth", "invalid-request", "config"] as const) {
      await withProviders({ codex: failing(kind), xai: answering("xai") }, async () => {
        await assert.rejects(
          () => routeSearch({ query: "q" }, providerContext()),
          (error: unknown) => {
            assert.ok(error instanceof GleanError);
            assert.equal(error.kind, kind);
            return true;
          },
        );
      });
    }
  });

  it("never falls through on an abort", async () => {
    await withProviders({ codex: failing("aborted"), xai: answering("xai") }, async () => {
      await assert.rejects(
        () => routeSearch({ query: "q" }, providerContext()),
        (error: unknown) => {
          assert.ok(error instanceof GleanError);
          assert.equal(error.kind, "aborted");
          return true;
        },
      );
    });
  });

  it("respects a customised fallbackOn list", async () => {
    const config = testConfig();
    config.search.fallbackOn = ["auth"];
    await withProviders({ codex: failing("auth"), xai: answering("xai") }, async () => {
      const result = await routeSearch({ query: "q" }, providerContext({ config }));
      assert.equal(result.backend, "xai");
    });
  });

  it("aggregates diagnostics when every backend fails", async () => {
    const config = testConfig();
    config.search.providers = ["codex", "xai"];
    await withProviders({ codex: failing("quota"), xai: failing("transient") }, async () => {
      await assert.rejects(
        () => routeSearch({ query: "q" }, providerContext({ config })),
        (error: unknown) => {
          assert.ok(error instanceof GleanError);
          assert.match(error.message, /All search backends failed/);
          assert.match(error.message, /codex \[quota\]/);
          assert.match(error.message, /xai \[transient\]/);
          return true;
        },
      );
    });
  });
});

describe("explicit backend", () => {
  it("uses only the named backend", async () => {
    let codexCalled = false;
    await withProviders(
      {
        codex: {
          isAvailable: async () => {
            codexCalled = true;
            return true;
          },
        },
        exa: answering("exa"),
      },
      async () => {
        const result = await routeSearch({ query: "q", backend: "exa" }, providerContext());
        assert.equal(result.backend, "exa");
        assert.equal(codexCalled, false, "other backends must not be probed");
      },
    );
  });

  it("reports a missing credential rather than silently skipping", async () => {
    // Asking for a backend by name is explicit intent; skipping it would be
    // more confusing than an error naming what is missing.
    await withProviders(
      { xai: { isAvailable: async () => false, ...failing("auth") } },
      async () => {
        await assert.rejects(
          () => routeSearch({ query: "q", backend: "xai" }, providerContext()),
          (error: unknown) => {
            assert.ok(error instanceof GleanError);
            assert.equal(error.kind, "auth");
            return true;
          },
        );
      },
    );
  });
});

describe("no backends at all", () => {
  it("explains that exa needs no credentials", async () => {
    const config = testConfig();
    config.search.providers = ["codex", "xai"];
    await withProviders({ codex: unavailable, xai: unavailable }, async () => {
      await assert.rejects(
        () => routeSearch({ query: "q" }, providerContext({ config })),
        (error: unknown) => {
          assert.ok(error instanceof GleanError);
          assert.equal(error.kind, "config");
          assert.match(error.hint ?? "", /exa needs no credentials/);
          assert.match(error.hint ?? "", /login openai-codex/);
          // grok-build, not xai: that is the grant a subscription lands in.
          assert.match(error.hint ?? "", /login grok-build/);
          return true;
        },
      );
    });
  });
});

describe("provider table", () => {
  it("marks exa as the only non-synthesized backend", () => {
    assert.equal(PROVIDERS.exa.synthesized, false);
    for (const backend of ["codex", "xai", "tavily", "perplexity"] as const) {
      assert.equal(PROVIDERS[backend].synthesized, true, backend);
    }
  });

  it("makes exa available without any credential", async () => {
    assert.equal(await PROVIDERS.exa.isAvailable(providerContext()), true);
  });
});
