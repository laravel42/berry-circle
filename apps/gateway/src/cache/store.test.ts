import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { RedisClient } from "bun";
import { type CacheStore, NullStore, ValkeyStore } from "~/cache/store";

describe("NullStore", () => {
  // Exercised through the CacheStore contract it satisfies.
  const store: CacheStore = new NullStore();

  it("always misses and no-ops writes", async () => {
    expect(await store.get("anything")).toBeNull();
    await store.set("k", "v", 30);
    expect(await store.get("k")).toBeNull();
  });

  it("reports zero removals and an unhealthy ping", async () => {
    await store.del(["a", "b"]);
    expect(await store.delByPrefix("p:")).toBe(0);
    expect(await store.ping()).toBe(false);
  });
});

describe("ValkeyStore circuit breaker", () => {
  it("fast-fails once consecutive failures cross the threshold, then probes after cooldown", async () => {
    let clock = 1000;
    // Port 6399 is intentionally dead so every real op fails.
    const store = new ValkeyStore({
      url: "redis://127.0.0.1:6399",
      opTimeoutMs: 50,
      breakerThreshold: 3,
      breakerCooldownMs: 5000,
      now: () => clock,
    });

    // First three ops attempt the backend and fail (breaker still closed).
    for (let i = 0; i < 3; i++) {
      await expect(store.get("k")).rejects.toThrow();
    }

    // Breaker is now open: the next op rejects instantly with the breaker error,
    // without attempting (or waiting on) the backend.
    await expect(store.get("k")).rejects.toThrow(/circuit breaker open/);

    // After the cooldown elapses the breaker half-opens and probes the backend
    // again — which fails with a connection error, not the breaker error.
    clock += 5001;
    await expect(store.get("k")).rejects.not.toThrow(/circuit breaker open/);

    await store.close();
  });
});

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";

/** Probe once so the integration block skips cleanly where no Valkey is running (e.g. CI). */
async function valkeyReachable(url: string): Promise<boolean> {
  const client = new RedisClient(url, {
    enableOfflineQueue: false,
    autoReconnect: false,
    connectionTimeout: 300,
  });
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 400)),
    ]);
    return typeof (await client.ping()) === "string";
  } catch {
    return false;
  } finally {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
}

const reachable = await valkeyReachable(VALKEY_URL);
if (!reachable) {
  // Visible signal in the test output that the live-backend block was skipped.
  console.info(
    `[cache] Valkey not reachable at ${VALKEY_URL}; skipping ValkeyStore integration tests`,
  );
}

describe.skipIf(!reachable)("ValkeyStore (integration)", () => {
  const ns = `berrytest:${randomUUID()}:`;
  const store = new ValkeyStore({ url: VALKEY_URL, opTimeoutMs: 1000 });

  afterAll(async () => {
    await store.delByPrefix(ns);
    await store.close();
  });

  it("round-trips a value within its TTL and misses on absent keys", async () => {
    await store.set(`${ns}a`, "hello", 30);
    expect(await store.get(`${ns}a`)).toBe("hello");
    expect(await store.get(`${ns}missing`)).toBeNull();
  });

  it("expires a value once its TTL elapses", async () => {
    await store.set(`${ns}ttl`, "x", 1);
    expect(await store.get(`${ns}ttl`)).toBe("x");
    await new Promise((r) => setTimeout(r, 1200));
    expect(await store.get(`${ns}ttl`)).toBeNull();
  });

  it("deletes exact keys", async () => {
    await store.set(`${ns}del`, "x", 30);
    await store.del([`${ns}del`]);
    expect(await store.get(`${ns}del`)).toBeNull();
  });

  it("delByPrefix removes matching keys and leaves others", async () => {
    await store.set(`${ns}list:1`, "1", 30);
    await store.set(`${ns}list:2`, "2", 30);
    await store.set(`${ns}other`, "3", 30);

    const removed = await store.delByPrefix(`${ns}list:`);

    expect(removed).toBe(2);
    expect(await store.get(`${ns}list:1`)).toBeNull();
    expect(await store.get(`${ns}other`)).toBe("3");
  });

  it("pings the live server", async () => {
    expect(await store.ping()).toBe(true);
  });
});
