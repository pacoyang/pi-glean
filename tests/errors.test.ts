import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CredentialResolutionError,
  DEFAULT_FALLBACK_ON,
  GleanError,
  classifyError,
  classifyHttpStatus,
  formatHttpErrorBody,
  isCloudflareChallenge,
  statusFromMessage,
} from "../src/errors.ts";

describe("classifyHttpStatus", () => {
  it("maps the status table", () => {
    assert.equal(classifyHttpStatus(401), "auth");
    assert.equal(classifyHttpStatus(403), "auth");
    assert.equal(classifyHttpStatus(400), "invalid-request");
    assert.equal(classifyHttpStatus(422), "invalid-request");
    assert.equal(classifyHttpStatus(402), "quota");
    assert.equal(classifyHttpStatus(429), "quota");
    assert.equal(classifyHttpStatus(404), "not_found");
    assert.equal(classifyHttpStatus(408), "transient");
    assert.equal(classifyHttpStatus(425), "transient");
    assert.equal(classifyHttpStatus(500), "transient");
    assert.equal(classifyHttpStatus(503), "transient");
  });
});

describe("classifyError", () => {
  it("returns a GleanError unchanged", () => {
    const original = new GleanError("quota", "slow down");
    assert.equal(classifyError(original), original);
  });

  it("classifies credential resolution failures", () => {
    assert.equal(classifyError(new CredentialResolutionError("tavily failed")).kind, "credential");
  });

  it("classifies aborts before anything else", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyError(abort).kind, "aborted");
  });

  it("prefers the HTTP status over message regexes", () => {
    // A 429 whose body mentions "unauthorized" is still a quota problem.
    const error = new Error("HTTP 429: unauthorized-looking body");
    const classified = classifyError(error);
    assert.equal(classified.kind, "quota");
    assert.equal(classified.status, 429);
  });

  it("falls back to message regexes when no status is present", () => {
    assert.equal(classifyError(new Error("rate limit exceeded")).kind, "quota");
    assert.equal(classifyError(new Error("Unauthorized")).kind, "auth");
    assert.equal(classifyError(new Error("Bad request")).kind, "invalid-request");
    assert.equal(classifyError(new Error("returned invalid response")).kind, "invalid-response");
    assert.equal(classifyError(new Error("service unavailable")).kind, "transient");
    assert.equal(classifyError(new Error("invalid config")).kind, "config");
  });

  it("classifies network failures, including bare TypeErrors from fetch", () => {
    assert.equal(classifyError(new TypeError("fetch failed")).kind, "network");
    assert.equal(classifyError(new Error("ECONNRESET")).kind, "network");
    assert.equal(classifyError(new Error("getaddrinfo ENOTFOUND example.com")).kind, "network");
  });

  it("falls through to unknown", () => {
    assert.equal(classifyError(new Error("something odd happened")).kind, "unknown");
  });

  it("records the source when given", () => {
    assert.equal(classifyError(new Error("boom"), "tavily").source, "tavily");
  });
});

describe("statusFromMessage", () => {
  it("extracts embedded status codes", () => {
    assert.equal(statusFromMessage("HTTP 503 Service Unavailable"), 503);
    assert.equal(statusFromMessage("error 429"), 429);
    assert.equal(statusFromMessage("status 401"), 401);
    assert.equal(statusFromMessage("no code here"), undefined);
  });
});

describe("Cloudflare handling", () => {
  it("detects challenge interstitials", () => {
    assert.equal(isCloudflareChallenge("<script src='/cdn-cgi/challenge-platform/x'>"), true);
    assert.equal(isCloudflareChallenge("Enable JavaScript and cookies to continue"), true);
    assert.equal(isCloudflareChallenge("ordinary error body"), false);
  });

  it("replaces the interstitial with advice instead of dumping HTML", () => {
    const formatted = formatHttpErrorBody("<html>cf_chl_ ...</html>");
    assert.match(formatted, /Cloudflare challenge blocked the request/);
    assert.doesNotMatch(formatted, /<html>/);
  });

  it("truncates long bodies", () => {
    assert.equal(formatHttpErrorBody("x".repeat(1000), 100).length, 101);
  });
});

describe("GleanError", () => {
  it("appends the hint to the display message", () => {
    const error = new GleanError("missing_binary", "yt-dlp missing", {
      hint: "brew install yt-dlp",
    });
    assert.equal(error.displayMessage, "yt-dlp missing\nbrew install yt-dlp");
  });

  it("omits the hint when there is none", () => {
    assert.equal(new GleanError("unknown", "plain").displayMessage, "plain");
  });
});

describe("DEFAULT_FALLBACK_ON", () => {
  it("only lists kinds where another backend could plausibly succeed", () => {
    assert.deepEqual([...DEFAULT_FALLBACK_ON], ["quota", "transient", "network"]);
    // auth / invalid-request / config would fail identically elsewhere and must
    // surface rather than being masked by a fallback.
    for (const masked of ["auth", "invalid-request", "config", "schema"]) {
      assert.ok(!(DEFAULT_FALLBACK_ON as readonly string[]).includes(masked));
    }
  });
});
