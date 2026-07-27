import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ConfigError,
  deleteConfig,
  getConfigPath,
  isProjectTrustedContext,
  loadConfig,
  resolveToolNames,
  saveConfig,
  scratchDir,
} from "../src/config.ts";

let workspace: string;
let homeConfig: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "glean-config-"));
  homeConfig = join(workspace, "home.json");
  process.env.PI_GLEAN_CONFIG = homeConfig;
});

afterEach(async () => {
  delete process.env.PI_GLEAN_CONFIG;
  delete process.env.PI_GLEAN_ENABLED;
  await rm(workspace, { recursive: true, force: true });
});

async function writeProject(content: unknown): Promise<void> {
  await mkdir(join(workspace, ".pi"), { recursive: true });
  await writeFile(join(workspace, ".pi", "pi-glean.json"), JSON.stringify(content), "utf-8");
}

async function writeHome(content: unknown): Promise<void> {
  await writeFile(homeConfig, JSON.stringify(content), "utf-8");
}

describe("layer precedence", () => {
  it("applies defaults when nothing is configured", async () => {
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.enabled, true);
    assert.equal(config.search.backend, "auto");
    assert.deepEqual(config.search.providers, ["codex", "xai", "tavily", "perplexity", "exa"]);
    assert.equal(config.search.batchSize, 5);
    assert.equal(config.toolNames.search, "glean_search");
  });

  it("lets project override home", async () => {
    await writeHome({ search: { batchSize: 3 } });
    await writeProject({ search: { batchSize: 7 } });
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.search.batchSize, 7);
  });

  it("lets env override both", async () => {
    await writeHome({ enabled: true });
    await writeProject({ enabled: true });
    process.env.PI_GLEAN_ENABLED = "false";
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.enabled, false);
  });

  it("skips the project layer when the project is untrusted", async () => {
    await writeHome({ search: { batchSize: 3 } });
    await writeProject({ search: { batchSize: 7 } });
    const config = await loadConfig({ cwd: workspace, isProjectTrusted: false });
    assert.equal(config.search.batchSize, 3);
  });

  it("deep-merges per section so a project key does not erase sibling home keys", async () => {
    await writeHome({ fetch: { timeoutMs: 1000, jina: { enabled: false } } });
    await writeProject({ fetch: { timeoutMs: 2000 } });
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.fetch.timeoutMs, 2000);
    assert.equal(config.fetch.jina.enabled, false, "home's fetch.jina must survive");
  });
});

describe("validation", () => {
  it("rejects an unknown backend and names the source file", async () => {
    await writeProject({ search: { backend: "bing" } });
    await assert.rejects(
      () => loadConfig({ cwd: workspace }),
      (error: Error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /search\.backend/);
        assert.match(error.message, /pi-glean\.json/);
        return true;
      },
    );
  });

  it("rejects an out-of-range batchSize", async () => {
    await writeProject({ search: { batchSize: 99 } });
    await assert.rejects(() => loadConfig({ cwd: workspace }), /between 1 and 32/);
  });

  it("rejects an unknown provider in the list", async () => {
    await writeProject({ search: { providers: ["codex", "bing"] } });
    await assert.rejects(() => loadConfig({ cwd: workspace }), /search\.providers\[1\]/);
  });

  it("rejects an error kind that does not exist", async () => {
    // A typo here would simply never match a real kind, silently turning off
    // backend fallback with nothing anywhere to say why.
    await writeProject({ search: { fallbackOn: ["quota", "quotas"] } });
    await assert.rejects(() => loadConfig({ cwd: workspace }), /search\.fallbackOn\[1\]/);
  });

  it("accepts the real error kinds", async () => {
    await writeProject({ search: { fallbackOn: ["timeout", "not_found"] } });
    const config = await loadConfig({ cwd: workspace });
    assert.deepEqual(config.search.fallbackOn, ["timeout", "not_found"]);
  });

  it("rejects a non-string entry in a string array", async () => {
    await writeProject({ youtube: { subtitleLangs: ["en", 42] } });
    await assert.rejects(() => loadConfig({ cwd: workspace }), /subtitleLangs\[1\]/);
  });

  it("reports malformed JSON with the path", async () => {
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(join(workspace, ".pi", "pi-glean.json"), "{ not json", "utf-8");
    await assert.rejects(() => loadConfig({ cwd: workspace }), /Failed to parse/);
  });

  it("rejects a non-boolean PI_GLEAN_ENABLED", async () => {
    process.env.PI_GLEAN_ENABLED = "yes";
    await assert.rejects(() => loadConfig({ cwd: workspace }), /must be "true" or "false"/);
  });

  it("passes free-form overrides through without validating their content", async () => {
    await writeProject({ search: { codex: { baseUrl: "not-a-url" } } });
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.search.codex.baseUrl, "not-a-url");
  });
});

describe("tool names", () => {
  it("rejects a name that shadows a pi builtin", () => {
    assert.throws(() => resolveToolNames({ fetch: "read" }, "test.json"), /shadows a pi builtin/);
  });

  it("rejects duplicates across keys", () => {
    assert.throws(
      () => resolveToolNames({ search: "dup", fetch: "dup" }, "test.json"),
      /both "dup"/,
    );
  });

  it("rejects a name that is not a valid identifier", () => {
    assert.throws(() => resolveToolNames({ search: "has space" }, "test.json"), /must match/);
  });

  it("accepts a valid override", () => {
    const names = resolveToolNames({ search: "my_search" }, "test.json");
    assert.equal(names.search, "my_search");
    assert.equal(names.fetch, "glean_fetch");
  });
});

describe("isProjectTrustedContext", () => {
  it("defaults to trusted when the field is absent", () => {
    assert.equal(isProjectTrustedContext({}), true);
    assert.equal(isProjectTrustedContext(undefined), true);
  });

  it("reads a boolean field", () => {
    assert.equal(isProjectTrustedContext({ isProjectTrusted: false }), false);
  });

  it("calls a function field", () => {
    assert.equal(isProjectTrustedContext({ isProjectTrusted: () => false }), false);
  });

  it("treats a throwing getter as untrusted", () => {
    assert.equal(
      isProjectTrustedContext({
        isProjectTrusted: () => {
          throw new Error("nope");
        },
      }),
      false,
    );
  });
});

describe("paths", () => {
  it("keeps scratch directories out of $HOME", () => {
    const dir = scratchDir("pdf");
    assert.ok(dir.startsWith(tmpdir()), `${dir} must live under ${tmpdir()}`);
    assert.ok(!dir.includes("Downloads"));
  });

  it("defaults pdf.outputDir and github.clonePath to scratch dirs", async () => {
    const config = await loadConfig({ cwd: workspace });
    assert.ok(config.pdf.outputDir.startsWith(tmpdir()));
    assert.ok(config.github.clonePath.startsWith(tmpdir()));
  });

  it("honours PI_GLEAN_CONFIG for the home layer", () => {
    assert.equal(getConfigPath("home", workspace), homeConfig);
  });
});

describe("save and delete", () => {
  it("round-trips through the project scope", async () => {
    await saveConfig("project", workspace, { search: { batchSize: 9 } });
    let config = await loadConfig({ cwd: workspace });
    assert.equal(config.search.batchSize, 9);

    assert.equal(await deleteConfig("project", workspace), true);
    config = await loadConfig({ cwd: workspace });
    assert.equal(config.search.batchSize, 5);
  });

  it("merges into an existing file rather than replacing it", async () => {
    await saveConfig("project", workspace, { search: { batchSize: 9 } });
    await saveConfig("project", workspace, { fetch: { timeoutMs: 1234 } });
    const config = await loadConfig({ cwd: workspace });
    assert.equal(config.search.batchSize, 9);
    assert.equal(config.fetch.timeoutMs, 1234);
  });

  it("returns false when deleting a file that is not there", async () => {
    assert.equal(await deleteConfig("project", workspace), false);
  });
});
