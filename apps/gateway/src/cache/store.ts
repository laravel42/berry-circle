import { RedisClient } from "bun";
import type { Logger } from "pino";

/**
 * Minimal string key/value contract the cache-aside layer depends on.
 *
 * Keeping the cache logic behind this interface (rather than calling Valkey
 * directly) is what makes cold-cache, malformed-value, and Valkey-unavailable
 * paths testable without a live server (ADR-0002 "test cold-cache paths"), and
 * lets the disabled/unavailable case degrade to a no-op store.
 *
 * Implementations MUST reject (not hang) when the backend is unreachable; the
 * `Cache` layer catches those rejections and fails open to the loader.
 */
export interface CacheStore {
  /** Return the raw stored string, or null on miss. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key` with a positive expiry in seconds. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Delete the given fully-qualified keys. No-op for an empty list. */
  del(keys: string[]): Promise<void>;
  /** Delete every key whose name starts with `prefix`. Returns the count removed. */
  delByPrefix(prefix: string): Promise<number>;
  /** Liveness probe; true when the backend answered. */
  ping(): Promise<boolean>;
  /** Release any underlying connection. Idempotent. */
  close(): Promise<void>;
}

/** Reject `p` if it has not settled within `ms` so a hung backend cannot stall a request. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cache ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface ValkeyStoreOptions {
  url: string;
  opTimeoutMs: number;
  logger?: Logger;
  /** Consecutive failures that trip the circuit breaker. Default 5. */
  breakerThreshold?: number;
  /** How long the breaker stays open before a probe, in ms. Default 3000. */
  breakerCooldownMs?: number;
  /** Clock injection for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * `CacheStore` backed by Bun's native Valkey/Redis client — no external
 * dependency. Fail-fast by design: the offline queue is disabled so commands
 * reject immediately while disconnected instead of piling up, and every command
 * is additionally bounded by `opTimeoutMs`. Background auto-reconnect stays on,
 * so the store heals itself once Valkey returns.
 *
 * A small circuit breaker guards the degraded path: once `breakerThreshold`
 * consecutive ops fail, further ops fail *instantly* for `breakerCooldownMs`
 * instead of each paying the full timeout. This keeps a Valkey outage from
 * adding timeout-sized latency to every hot read. The `Cache` layer treats the
 * instant rejection exactly like any other failure — a miss.
 */
export class ValkeyStore implements CacheStore {
  private readonly url: string;
  private readonly opTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly now: () => number;
  private client?: RedisClient;
  private connecting?: Promise<void>;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(options: ValkeyStoreOptions) {
    this.url = options.url;
    this.opTimeoutMs = options.opTimeoutMs;
    this.logger = options.logger;
    this.breakerThreshold = options.breakerThreshold ?? 5;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 3000;
    this.now = options.now ?? Date.now;
  }

  private get raw(): RedisClient {
    if (!this.client) {
      this.client = new RedisClient(this.url, {
        // Fail fast rather than buffer commands while Valkey is down; the cache
        // is optional, so a miss beats a queued command that resolves late.
        enableOfflineQueue: false,
        autoReconnect: true,
        connectionTimeout: this.opTimeoutMs,
      });
      this.client.onclose = (error) => {
        this.logger?.debug({ err: error }, "cache: valkey connection closed");
      };
    }
    return this.client;
  }

  private async ensureConnected(): Promise<void> {
    const client = this.raw;
    if (client.connected) return;
    if (!this.connecting) {
      this.connecting = client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
    }
    await withTimeout(this.connecting, this.opTimeoutMs, "connect");
  }

  private async exec<T>(label: string, run: (client: RedisClient) => Promise<T>): Promise<T> {
    if (this.now() < this.breakerOpenUntil) {
      throw new Error("cache circuit breaker open");
    }
    try {
      await this.ensureConnected();
      const result = await withTimeout(run(this.raw), this.opTimeoutMs, label);
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.breakerThreshold) {
        this.breakerOpenUntil = this.now() + this.breakerCooldownMs;
        this.consecutiveFailures = 0;
        this.logger?.debug(
          { cooldownMs: this.breakerCooldownMs },
          "cache: circuit breaker opened after repeated valkey failures",
        );
      }
      throw error;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.exec("get", (client) => client.get(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.exec("set", (client) => client.set(key, value, "EX", ttlSeconds));
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // UNLINK reclaims memory off the main thread — better than DEL for bulk removal.
    await this.exec("del", (client) => client.send("UNLINK", keys));
  }

  async delByPrefix(prefix: string): Promise<number> {
    // Non-blocking SCAN + UNLINK. KEYS would block the server on large keyspaces;
    // SCAN walks the keyspace in bounded batches instead.
    const match = `${prefix}*`;
    let cursor = "0";
    let removed = 0;
    do {
      const reply = (await this.exec("scan", (client) =>
        client.send("SCAN", [cursor, "MATCH", match, "COUNT", "200"]),
      )) as [string, string[]];
      cursor = reply[0];
      const batch = reply[1];
      if (batch.length > 0) {
        await this.exec("unlink", (client) => client.send("UNLINK", batch));
        removed += batch.length;
      }
    } while (cursor !== "0");
    return removed;
  }

  async ping(): Promise<boolean> {
    const reply = await this.exec("ping", (client) => client.ping());
    return typeof reply === "string" && reply.toUpperCase() === "PONG";
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      this.client.close();
    } finally {
      this.client = undefined;
      this.connecting = undefined;
    }
  }
}

/**
 * No-op store used when the cache is disabled. Every read misses and every
 * write is dropped, so the gateway runs identically to a permanent cache
 * outage — the correctness baseline the ADR requires.
 */
export class NullStore implements CacheStore {
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {
    // intentionally empty
  }
  async del(): Promise<void> {
    // intentionally empty
  }
  async delByPrefix(): Promise<number> {
    return 0;
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {
    // intentionally empty
  }
}
