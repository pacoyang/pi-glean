import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildErrorPlan,
  imageBadge,
  progressBar,
  renderErrorPlan,
  renderFetchResult,
  renderFetchStatus,
  renderSearchStatus,
} from "../src/render.ts";
import { renderActivityLines } from "../src/widget.ts";
import type { ActivityEntry } from "../src/activity.ts";

describe("progressBar", () => {
  it("fills proportionally to progress", () => {
    assert.equal(progressBar(0, "fetching"), "[░░░░░░░░░░] fetching");
    assert.equal(progressBar(0.5, "fetching"), "[█████░░░░░] fetching");
    assert.equal(progressBar(1, "done"), "[██████████] done");
  });

  it("clamps out-of-range values", () => {
    assert.equal(progressBar(-1, "x"), "[░░░░░░░░░░] x");
    assert.equal(progressBar(5, "x"), "[██████████] x");
  });
});

describe("imageBadge", () => {
  it("distinguishes one image from several", () => {
    assert.equal(imageBadge(0), "");
    assert.equal(imageBadge(undefined), "");
    assert.equal(imageBadge(1), " [image]");
    assert.equal(imageBadge(3), " [3 images]");
  });
});

describe("fetch rendering", () => {
  it("shows title, size, badges and route for a single URL", () => {
    const status = renderFetchStatus({
      urlCount: 1,
      title: "React 19",
      totalChars: 18432,
      imageCount: 3,
      truncated: true,
      via: "jina",
      duration: 5043,
    });
    assert.match(status, /React 19 \(18432 chars\)/);
    assert.match(status, /\[3 images]/);
    assert.match(status, /\[truncated]/);
    assert.match(status, /via jina/);
    assert.match(status, /1:24:03/);
  });

  it("summarises a multi-URL fetch", () => {
    assert.equal(renderFetchStatus({ urlCount: 5, successful: 3 }), "3/5 URLs (content stored)");
  });

  it("previews 200 chars collapsed and 500 expanded", () => {
    const text = "x".repeat(1000);
    const collapsed = renderFetchResult({ urlCount: 1, title: "t" }, text, false);
    const expanded = renderFetchResult({ urlCount: 1, title: "t" }, text, true);
    assert.ok(collapsed.length < expanded.length);
    assert.match(collapsed, /…$/);
    assert.match(expanded, /…$/);
  });

  it("shows media parameters only when expanded", () => {
    const details = {
      urlCount: 1,
      title: "clip",
      prompt: "what happens",
      timestamp: "1:23-2:30",
      frames: 6,
    };
    assert.doesNotMatch(renderFetchResult(details, "body", false), /timestamp/);
    const expanded = renderFetchResult(details, "body", true);
    assert.match(expanded, /prompt: "what happens"/);
    assert.match(expanded, /timestamp: 1:23-2:30/);
    assert.match(expanded, /frames: 6/);
  });
});

describe("search rendering", () => {
  it("names the backend and flags a background prefetch", () => {
    const status = renderSearchStatus({
      queryCount: 3,
      successful: 3,
      backend: "codex",
      contentFetchId: "abc123",
    });
    assert.match(status, /3\/3 queries/);
    assert.match(status, /via codex/);
    assert.match(status, /fetching sources/);
  });

  it("joins several backends", () => {
    assert.match(renderSearchStatus({ backend: ["codex", "exa"] }), /via codex, exa/);
  });
});

describe("error plans", () => {
  it("returns null when there is no error", () => {
    assert.equal(buildErrorPlan({}), null);
    assert.equal(buildErrorPlan(undefined), null);
  });

  it("keeps a bare argument error to a single line", () => {
    // Nothing to diagnose here — expanding should not promise more.
    const plan = buildErrorPlan({ error: "No URL provided", kind: "schema" })!;
    assert.deepEqual(plan.expanded, ["No URL provided [schema]"]);
    assert.equal(plan.expandHint, null);
    assert.deepEqual(plan.collapsed, []);
  });

  it("gives the error path a real expanded view", () => {
    // Upstream returned one line on errors, which made ctrl+o a dead end.
    const plan = buildErrorPlan({
      error: "All search backends failed",
      kind: "quota",
      hint: "Run `/login xai` to add a second backend.",
      extraLines: ["codex [quota]: rate limited", "xai [transient]: 503"],
    })!;

    const collapsed = renderErrorPlan(plan, false);
    const expanded = renderErrorPlan(plan, true);
    assert.ok(expanded.length > collapsed.length, "expanding must reveal more");
    assert.match(expanded, /codex \[quota]/);
    assert.match(expanded, /xai \[transient]/);
    assert.match(collapsed, /ctrl\+o to expand/);
  });

  it("counts the hidden lines accurately", () => {
    const plan = buildErrorPlan({
      error: "boom",
      extraLines: ["one", "two", "three"],
    })!;
    const hidden = plan.expanded.length - (1 + plan.collapsed.length);
    assert.match(plan.expandHint ?? "", new RegExp(`${hidden} more lines`));
  });
});

describe("activity widget", () => {
  function entry(partial: Partial<ActivityEntry>): ActivityEntry {
    return { id: "a", type: "fetch", startTime: 0, status: null, ...partial };
  }

  it("marks an in-flight request distinctly from a failure", () => {
    // logError leaves status null, so the widget must not read "no status" as
    // "still running".
    const lines = renderActivityLines(
      [
        entry({ url: "https://react.dev/blog", status: null, endTime: 800 }),
        entry({ url: "https://x.example/", status: null, error: "ECONNRESET", endTime: 300 }),
        entry({ type: "api", query: "React 19", status: 200, endTime: 2100 }),
      ],
      new Map(),
      3000,
    );
    const text = lines.join("\n");
    assert.match(text, /···/, "pending shows a placeholder status");
    assert.match(text, /err.*✗/s, "an error shows as failed");
    assert.match(text, /200.*✓/s);
  });

  it("shows the fallback route when one was taken", () => {
    const text = renderActivityLines(
      [entry({ url: "https://spa.example/", status: 200, via: "jina" })],
      new Map(),
    ).join("\n");
    assert.match(text, /→ jina/);
  });

  it("reports rate-limit headroom when a window is in use", () => {
    const text = renderActivityLines([], new Map([["jina", { used: 4, max: 20 }]])).join("\n");
    assert.match(text, /jina: 4\/20 in window/);
  });

  it("omits idle rate limiters", () => {
    const text = renderActivityLines([], new Map([["perplexity", { used: 0, max: 10 }]])).join(
      "\n",
    );
    assert.doesNotMatch(text, /perplexity/);
  });

  it("says so when nothing has happened yet", () => {
    assert.match(renderActivityLines([], new Map()).join("\n"), /no requests yet/);
  });

  it("keeps every line within a narrow terminal", () => {
    const lines = renderActivityLines(
      [entry({ url: `https://example.com/${"x".repeat(200)}`, status: 200, endTime: 1000 })],
      new Map(),
    );
    for (const line of lines) {
      assert.ok(line.length <= 70, `line too wide (${line.length}): ${line}`);
    }
  });
});
