import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchRemoteUrl,
  isBlockedIPv4,
  isBlockedIPv6,
  parseAllowRanges,
  resolvesPrivately,
  validateRemoteUrl,
  type Lookup,
} from "../src/fetch/ssrf.ts";

/** Resolves every hostname to a fixed address, so no DNS is involved. */
function lookupReturning(...addresses: string[]): Lookup {
  return async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

describe("blocked address ranges", () => {
  it("blocks loopback, RFC1918, CGNAT, link-local and multicast", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254", // cloud metadata — the one that leaks credentials
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      assert.equal(isBlockedIPv4(address), true, address);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1"]) {
      assert.equal(isBlockedIPv4(address), false, address);
    }
  });

  it("blocks IPv6 loopback, ULA, link-local and mapped private v4", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert.equal(isBlockedIPv6(address), true, address);
    }
    assert.equal(isBlockedIPv6("2606:4700:4700::1111"), false);
  });
});

describe("validateRemoteUrl", () => {
  it("rejects non-HTTP schemes", async () => {
    await assert.rejects(() => validateRemoteUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
    await assert.rejects(() => validateRemoteUrl("ftp://example.com"), /Only HTTP and HTTPS/);
  });

  it("rejects localhost by name without resolving it", async () => {
    await assert.rejects(
      () => validateRemoteUrl("http://localhost:8080"),
      /Blocked internal hostname/,
    );
    await assert.rejects(
      () => validateRemoteUrl("http://api.localhost/"),
      /Blocked internal hostname/,
    );
  });

  it("rejects a literal private IP", async () => {
    await assert.rejects(
      () => validateRemoteUrl("http://169.254.169.254/latest/meta-data/"),
      /Blocked internal address/,
    );
  });

  it("rejects a public name that resolves privately (DNS rebinding)", async () => {
    await assert.rejects(
      () => validateRemoteUrl("https://evil.example", { lookup: lookupReturning("10.0.0.5") }),
      /Blocked internal address/,
    );
  });

  it("rejects when any resolved address is private, not just the first", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://evil.example", {
          lookup: lookupReturning("93.184.216.34", "127.0.0.1"),
        }),
      /Blocked internal address/,
    );
  });

  it("accepts a public host", async () => {
    const url = await validateRemoteUrl("https://example.com/x", {
      lookup: lookupReturning("93.184.216.34"),
    });
    assert.equal(url.hostname, "example.com");
  });

  it("hints at fake-IP proxies for the 198.18/15 range", async () => {
    await assert.rejects(
      () => validateRemoteUrl("https://x.example", { lookup: lookupReturning("198.18.0.1") }),
      /198\.18\.0\.0\/15.*allowRanges/s,
    );
  });
});

describe("allowRanges", () => {
  it("exempts an explicitly allowed CIDR", async () => {
    const url = await validateRemoteUrl("https://x.example", {
      lookup: lookupReturning("198.18.0.5"),
      allowRanges: ["198.18.0.0/15"],
    });
    assert.equal(url.hostname, "x.example");
  });

  it("does not exempt addresses outside the range", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://x.example", {
          lookup: lookupReturning("10.0.0.1"),
          allowRanges: ["198.18.0.0/15"],
        }),
      /Blocked internal address/,
    );
  });

  it("never matches an IPv4 address against an IPv6 rule", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://x.example", {
          lookup: lookupReturning("10.0.0.1"),
          allowRanges: ["fd00::/8"],
        }),
      /Blocked internal address/,
    );
  });

  it("rejects a trailing slash with no prefix rather than treating it as /0", () => {
    // Number("") is 0, so a lenient parse would exempt the entire address space.
    assert.throws(() => parseAllowRanges(["198.18.0.0/"]), /Invalid CIDR/);
  });

  it("rejects malformed entries loudly", () => {
    assert.throws(() => parseAllowRanges(["not-an-ip"]), /Invalid CIDR/);
    assert.throws(() => parseAllowRanges([42]), /must be strings/);
    assert.throws(() => parseAllowRanges("10.0.0.0/8"), /must be an array/);
    assert.throws(() => parseAllowRanges(["10.0.0.0/33"]), /Invalid CIDR/);
  });

  it("accepts a bare address as a host route", () => {
    assert.equal(parseAllowRanges(["1.2.3.4"]).length, 1);
  });
});

describe("domain policy", () => {
  const lookup = lookupReturning("93.184.216.34");

  it("denies a listed domain and its subdomains", async () => {
    const policy = { allow: [], deny: ["blocked.example"] };
    await assert.rejects(
      () => validateRemoteUrl("https://blocked.example/x", { lookup, domainPolicy: policy }),
      /Blocked hostname by domain policy/,
    );
    await assert.rejects(
      () => validateRemoteUrl("https://sub.blocked.example/x", { lookup, domainPolicy: policy }),
      /Blocked hostname by domain policy/,
    );
  });

  it("restricts to the allow list when one is set", async () => {
    const policy = { allow: ["good.example"], deny: [] };
    await assert.doesNotReject(() =>
      validateRemoteUrl("https://good.example", { lookup, domainPolicy: policy }),
    );
    await assert.rejects(
      () => validateRemoteUrl("https://other.example", { lookup, domainPolicy: policy }),
      /not allowed by domain policy/,
    );
  });

  it("lets deny win over allow", async () => {
    const policy = { allow: ["example.com"], deny: ["secret.example.com"] };
    await assert.rejects(
      () => validateRemoteUrl("https://secret.example.com", { lookup, domainPolicy: policy }),
      /Blocked hostname/,
    );
  });
});

describe("redirects", () => {
  function redirectingFetch(chain: Record<string, string>): typeof fetch {
    return (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const location = chain[url];
      if (location) {
        return new Response(null, { status: 302, headers: { location } });
      }
      return new Response("final", { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("revalidates every hop, so a public URL cannot redirect inward", async () => {
    // The core reason redirects are followed manually.
    await assert.rejects(
      () =>
        fetchRemoteUrl(
          "https://public.example/start",
          {},
          {
            lookup: async (hostname) => [
              {
                address: hostname === "public.example" ? "93.184.216.34" : "169.254.169.254",
                family: 4,
              },
            ],
            fetch: redirectingFetch({
              "https://public.example/start": "https://metadata.internal/",
            }),
          },
        ),
      /Blocked internal address/,
    );
  });

  it("follows a chain of public redirects", async () => {
    const response = await fetchRemoteUrl(
      "https://a.example/",
      {},
      {
        lookup: lookupReturning("93.184.216.34"),
        fetch: redirectingFetch({
          "https://a.example/": "https://b.example/",
          "https://b.example/": "https://c.example/",
        }),
      },
    );
    assert.equal(await response.text(), "final");
  });

  it("stops after the redirect limit", async () => {
    const loop: typeof fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://a.example/next" },
      })) as never;
    await assert.rejects(
      () =>
        fetchRemoteUrl(
          "https://a.example/",
          {},
          { lookup: lookupReturning("93.184.216.34"), fetch: loop },
        ),
      /Too many redirects/,
    );
  });
});

describe("resolvesPrivately", () => {
  it("reports private hosts so the Jina fallback can refuse them", async () => {
    assert.equal(await resolvesPrivately("localhost"), true);
    assert.equal(await resolvesPrivately("127.0.0.1"), true);
    assert.equal(await resolvesPrivately("internal", lookupReturning("10.0.0.1")), true);
  });

  it("reports public hosts as safe to forward", async () => {
    assert.equal(await resolvesPrivately("example.com", lookupReturning("93.184.216.34")), false);
  });

  it("treats an unresolvable host as unsafe", async () => {
    assert.equal(
      await resolvesPrivately("nope.invalid", async () => {
        throw new Error("ENOTFOUND");
      }),
      true,
    );
  });
});
