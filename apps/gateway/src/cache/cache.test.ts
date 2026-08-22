import { beforeEach, describe, expect, it } from "bun:test";
import { pino } from "pino";
import { Cache } from "~/cache/cache";
import type { CacheStore } from "~/cache/store";

const PREFIX = "test";
const VERSION = 1;
const silentLogger = pino({ level: "silent" });

/** Qualified key as the Cache layer stores it. */
const q = (logicalKey: string, version = VERSION) => `${PREFIX}:cache:v${version}:${logicalKey}`;

/**
 * In-memory `CacheStore` with a controllable logical clock (for TTL/expiry),
 * a fail-all switch (for Valkey-unavailable paths), raw seeding (for malformed
 * values), and op counters (to assert cache-aside call patterns).
 */
class FakeStore implements CacheStore {
  map = new Map<string, { value: string; expiresAt: number }>();
  now = 0;
  failAll = false;
  ops = { get: 0, set: 0, del: 0, scan: 0, ping: 0 };

  private guard() {
    if (this.failAll) throw new Error("valkey unavailable");
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    this.ops.get++;
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.now >= entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.guard();
    this.ops.set++;
    this.map.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
  }

  async del(keys: string[]): Promise<void> {
    this.guard();
    this.ops.del++;
    for (const key of keys) this.map.delete(key);
  }

  async delByPrefix(prefix: string): Promise<number> {
    this.guard();
    this.ops.scan++;
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async ping(): Promise<boolean> {
    this.guard();
    this.ops.ping++;
    return true;
  }

  async close(): Promise<void> {}

  /** Insert a raw (possibly malformed) value directly, bypassing serialization. */
  seedRaw(key: string, raw: string): void {
    this.map.set(key, { value: raw, expiresAt: this.now + 10_000 });
  }
}

function makeCache(store: CacheStore, enabled = true): Cache {
  return new Cache({
    store,
    logger: silentLogger,
    enabled,
    keyPrefix: PREFIX,
    schemaVersion: VERSION,
    defaultTtlSeconds: 30,
  });
}

/** A deferred promise, for driving single-flight timing deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Cache.getOrLoad", () => {
  let store: FakeStore;
  let cache: Cache;

  beforeEach(() => {
    store = new FakeStore();
    cache = makeCache(store);
  });

  it("misses on a cold key, runs the loader, and populates the cache", async () => {
    let calls = 0;
    const value = await cache.getOrLoad("board:1", async () => {
      calls++;
      return { id: "1", name: "Berry" };
    });

    expect(value).toEqual({ id: "1", name: "Berry" });
    expect(calls).toBe(1);
    expect(store.map.has(q("board:1"))).toBe(true);
    expect(cache.getStats()).toMatchObject({ misses: 1, hits: 0 });
  });

  it("serves a warm key from cache without re-running the loader", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return { id: "1" };
    };

    await cache.getOrLoad("board:1", loader);
    const second = await cache.getOrLoad("board:1", loader);

    expect(second).toEqual({ id: "1" });
    expect(calls).toBe(1);
    expect(cache.getStats().hits).toBe(1);
  });

  it("honors the configured TTL: reloads once the entry has expired", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return calls;
    };

    const first = await cache.getOrLoad("board:1", loader, { ttlSeconds: 15 });
    expect(first).toBe(1);

    store.now += 14_000; // still within TTL
    expect(await cache.getOrLoad("board:1", loader, { ttlSeconds: 15 })).toBe(1);
    expect(calls).toBe(1);

    store.now += 2_000; // now past the 15s TTL
    expect(await cache.getOrLoad("board:1", loader, { ttlSeconds: 15 })).toBe(2);
    expect(calls).toBe(2);
  });

  it("coalesces concurrent identical cold loads into a single loader call", async () => {
    const gate = deferred<number>();
    let calls = 0;
    const loader = () => {
      calls++;
      return gate.promise;
    };

    const a = cache.getOrLoad("board:1", loader);
    const b = cache.getOrLoad("board:1", loader);
    gate.resolve(42);

    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(calls).toBe(1);
  });

  it("caches a JSON null value distinctly from a miss", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return null;
    };

    expect(await cache.getOrLoad("issue:1", loader)).toBeNull();
    expect(await cache.getOrLoad("issue:1", loader)).toBeNull();
    expect(calls).toBe(1); // second call is a cache hit on the stored null
    expect(cache.getStats().hits).toBe(1);
  });
});

describe("Cache invalidation", () => {
  let store: FakeStore;
  let cache: Cache;

  beforeEach(() => {
    store = new FakeStore();
    cache = makeCache(store);
  });

  it("invalidate() drops an exact key so the next read reloads", async () => {
    let calls = 0;
    const loader = async () => ++calls;

    await cache.getOrLoad("board:1", loader);
    await cache.invalidate("board:1");
    await cache.getOrLoad("board:1", loader);

    expect(calls).toBe(2);
  });

  it("invalidateByPrefix() drops every page under a list prefix", async () => {
    await cache.set("issues:list:b1:aaa", [1]);
    await cache.set("issues:list:b1:bbb", [2]);
    await cache.set("issues:list:b2:ccc", [3]);

    const removed = await cache.invalidateByPrefix("issues:list:b1:");

    expect(removed).toBe(2);
    expect(await cache.get("issues:list:b1:aaa")).toBeUndefined();
    expect(await cache.get("issues:list:b1:bbb")).toBeUndefined();
    expect(await cache.get<number[]>("issues:list:b2:ccc")).toEqual([3]); // other board untouched
  });
});

describe("Cache malformed values", () => {
  let store: FakeStore;
  let cache: Cache;

  beforeEach(() => {
    store = new FakeStore();
    cache = makeCache(store);
  });

  it("treats non-JSON as a miss", async () => {
    store.seedRaw(q("board:1"), "definitely not json");
    expect(await cache.get("board:1")).toBeUndefined();
    expect(cache.getStats().malformed).toBe(1);
  });

  it("treats a wrong-version envelope as a miss", async () => {
    store.seedRaw(q("board:1"), JSON.stringify({ v: 999, d: { id: "1" } }));
    expect(await cache.get("board:1")).toBeUndefined();
    expect(cache.getStats().malformed).toBe(1);
  });

  it("treats an envelope missing its data field as a miss", async () => {
    store.seedRaw(q("board:1"), JSON.stringify({ v: VERSION }));
    expect(await cache.get("board:1")).toBeUndefined();
  });

  it("reloads through the loader when the cached value is malformed", async () => {
    store.seedRaw(q("board:1"), "{corrupt");
    const value = await cache.getOrLoad("board:1", async () => ({ id: "fresh" }));
    expect(value).toEqual({ id: "fresh" });
  });
});

describe("Cache fail-open on backend errors", () => {
  let store: FakeStore;
  let cache: Cache;

  beforeEach(() => {
    store = new FakeStore();
    store.failAll = true;
    cache = makeCache(store);
  });

  it("returns the loader result when the backend read fails", async () => {
    let calls = 0;
    const value = await cache.getOrLoad("board:1", async () => {
      calls++;
      return "from-db";
    });
    expect(value).toBe("from-db");
    expect(calls).toBe(1);
    expect(cache.getStats().errors).toBeGreaterThan(0);
  });

  it("get() resolves to undefined instead of throwing", async () => {
    expect(await cache.get("board:1")).toBeUndefined();
  });

  it("invalidate() and invalidateByPrefix() swallow backend errors", async () => {
    await expect(cache.invalidate("board:1")).resolves.toBeUndefined();
    await expect(cache.invalidateByPrefix("issues:list:b1:")).resolves.toBe(0);
  });

  it("healthy() reports false when the backend is down", async () => {
    expect(await cache.healthy()).toBe(false);
  });
});

describe("Cache disabled", () => {
  it("always runs the loader and never touches the store", async () => {
    const store = new FakeStore();
    const cache = makeCache(store, false);
    let calls = 0;
    const loader = async () => ++calls;

    await cache.getOrLoad("board:1", loader);
    await cache.getOrLoad("board:1", loader);

    expect(calls).toBe(2);
    expect(store.ops.get).toBe(0);
    expect(store.ops.set).toBe(0);
    expect(cache.isEnabled).toBe(false);
    expect(await cache.healthy()).toBe(false);
  });
});

describe("Cache schema versioning", () => {
  it("a version bump abandons values written under the old version", async () => {
    const store = new FakeStore();
    const v1 = makeCache(store);
    await v1.set("board:1", { id: "1" });
    expect(await v1.get<{ id: string }>("board:1")).toEqual({ id: "1" });

    const v2 = new Cache({
      store,
      logger: silentLogger,
      enabled: true,
      keyPrefix: PREFIX,
      schemaVersion: 2,
      defaultTtlSeconds: 30,
    });

    expect(await v2.get("board:1")).toBeUndefined(); // different key head → not found
  });
});
