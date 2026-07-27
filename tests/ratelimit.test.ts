import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter, type RateLimitInfo } from "../src/ratelimit.ts";

/** Virtual clock so the window can be exercised without real waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Aborted while waiting for rate limit");
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RateLimiter", () => {
  it("lets requests through while the window has room", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    assert.deepEqual(clock.sleeps, [], "no waiting until the window is full");
    assert.equal(limiter.info().used, 3);
  });

  it("waits rather than throwing when the window is full", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // must not reject
    assert.equal(clock.sleeps.length, 1);
    assert.equal(clock.sleeps[0], 1000, "waits until the oldest entry leaves the window");
  });

  it("releases the slot once the window slides past", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    clock.advance(1001);
    await limiter.acquire();
    assert.deepEqual(clock.sleeps, [], "no wait needed after the window slides");
  });

  it("reports usage to onUpdate", async () => {
    const clock = fakeClock();
    const seen: RateLimitInfo[] = [];
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
      onUpdate: (info) => seen.push(info),
    });
    await limiter.acquire();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.used, 1);
    assert.equal(seen[0]?.max, 2);
    assert.equal(seen[0]?.windowMs, 1000);
  });

  it("propagates an abort while waiting", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    controller.abort();
    await assert.rejects(() => limiter.acquire(controller.signal), /Aborted/);
  });

  it("stays usable after a waiter aborts", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    controller.abort();
    await assert.rejects(() => limiter.acquire(controller.signal));
    clock.advance(1001);
    await limiter.acquire();
    assert.equal(limiter.info().used, 1);
  });

  it("keeps separate instances independent", async () => {
    const clock = fakeClock();
    const perplexity = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const jina = new RateLimiter({
      maxRequests: 20,
      windowMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await perplexity.acquire();
    await jina.acquire();
    assert.equal(perplexity.info().used, 1);
    assert.equal(jina.info().used, 1);
    assert.equal(jina.info().max, 20);
  });
});
