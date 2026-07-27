import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piGlean from "../index.ts";

interface RegisteredTool {
  name: string;
  label: string;
}

interface FakeApi {
  api: ExtensionAPI;
  tools: RegisteredTool[];
  commands: string[];
  providers: string[];
  handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
}

function fakeApi(): FakeApi {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  const providers: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();

  const api = {
    registerTool(tool: RegisteredTool) {
      tools.push({ name: tool.name, label: tool.label });
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerProvider(name: string) {
      providers.push(name);
    },
    registerShortcut() {},
    appendEntry() {},
    sendMessage() {},
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  return { api, tools, commands, providers, handlers };
}

function fakeCtx(cwd: string, keys: Record<string, string> = {}): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: { getApiKeyForProvider: (provider: string) => keys[provider] },
    sessionManager: { getBranch: () => [], getSessionId: () => "sess-1" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "glean-reg-"));
  process.env.PI_GLEAN_CONFIG = join(workspace, "home.json");
});

afterEach(async () => {
  delete process.env.PI_GLEAN_CONFIG;
  delete process.env.PI_GLEAN_ENABLED;
  await rm(workspace, { recursive: true, force: true });
});

describe("eager registration", () => {
  it("registers the search tool and the xai provider at load time", async () => {
    const fake = fakeApi();
    await piGlean(fake.api);
    assert.deepEqual(
      fake.tools.map((t) => t.name),
      ["glean_search"],
    );
    assert.deepEqual(fake.providers, ["xai"]);
    assert.ok(fake.commands.includes("glean-status"));
  });

  it("registers the xai provider exactly once", async () => {
    const fake = fakeApi();
    await piGlean(fake.api);
    assert.equal(fake.providers.filter((p) => p === "xai").length, 1);
  });

  it("registers nothing when disabled", async () => {
    process.env.PI_GLEAN_ENABLED = "false";
    const fake = fakeApi();
    await piGlean(fake.api);
    assert.deepEqual(fake.tools, []);
    assert.deepEqual(fake.providers, []);
  });
});

describe("deferred x_search registration", () => {
  async function startSession(fake: FakeApi, keys: Record<string, string>): Promise<void> {
    const handlers = fake.handlers.get("session_start") ?? [];
    for (const handler of handlers) await handler({}, fakeCtx(workspace, keys));
  }

  it("does not register x_search when xAI is not authenticated", async () => {
    // Otherwise every user without an xAI subscription carries a tool that can
    // only fail — burning prompt tokens and inviting wrong calls.
    const fake = fakeApi();
    await piGlean(fake.api);
    await startSession(fake, {});
    assert.ok(!fake.tools.some((t) => t.name === "glean_x_search"));
  });

  it("registers x_search once xAI auth is present", async () => {
    const fake = fakeApi();
    await piGlean(fake.api);
    await startSession(fake, { xai: "xai-token" });
    assert.ok(fake.tools.some((t) => t.name === "glean_x_search"));
  });

  it("registers x_search only once across repeated session events", async () => {
    const fake = fakeApi();
    await piGlean(fake.api);
    await startSession(fake, { xai: "xai-token" });
    await startSession(fake, { xai: "xai-token" });
    assert.equal(fake.tools.filter((t) => t.name === "glean_x_search").length, 1);
  });

  it("skips x_search when the tool is disabled in config", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace, "home.json"),
      JSON.stringify({ tools: { xSearch: false } }),
      "utf-8",
    );
    const fake = fakeApi();
    await piGlean(fake.api);
    await startSession(fake, { xai: "xai-token" });
    assert.ok(!fake.tools.some((t) => t.name === "glean_x_search"));
  });
});

describe("tool name overrides", () => {
  it("applies configured names", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace, "home.json"),
      JSON.stringify({ toolNames: { search: "my_search", xSearch: "my_x" } }),
      "utf-8",
    );
    const fake = fakeApi();
    await piGlean(fake.api);
    assert.deepEqual(
      fake.tools.map((t) => t.name),
      ["my_search"],
    );
  });

  it("refuses to start with a name that collides with a pi builtin", async () => {
    // pi drops duplicate tool names silently, so this has to fail loudly here.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace, "home.json"),
      JSON.stringify({ toolNames: { fetch: "read" } }),
      "utf-8",
    );
    const fake = fakeApi();
    await assert.rejects(() => piGlean(fake.api), /shadows a pi builtin/);
  });

  it("refuses to start with duplicate tool names", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace, "home.json"),
      JSON.stringify({ toolNames: { search: "dup", fetch: "dup" } }),
      "utf-8",
    );
    const fake = fakeApi();
    await assert.rejects(() => piGlean(fake.api), /both "dup"/);
  });
});

describe("session lifecycle", () => {
  it("subscribes to start, tree and shutdown", async () => {
    const fake = fakeApi();
    await piGlean(fake.api);
    for (const event of ["session_start", "session_tree", "session_shutdown"]) {
      assert.ok(fake.handlers.has(event), `missing handler for ${event}`);
    }
  });

  it("keeps running when the project config is malformed", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(join(workspace, ".pi", "pi-glean.json"), "{ broken", "utf-8");

    const fake = fakeApi();
    await piGlean(fake.api);
    const handlers = fake.handlers.get("session_start") ?? [];
    // A bad config surfaces as a message, not as a dead extension.
    for (const handler of handlers) {
      await assert.doesNotReject(() => Promise.resolve(handler({}, fakeCtx(workspace))));
    }
    assert.ok(fake.tools.some((t) => t.name === "glean_search"));
  });
});
