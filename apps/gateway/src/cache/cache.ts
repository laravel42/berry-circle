import type { Logger } from "pino";
import type { CacheStore } from "~/cache/store";

/**
 * Versioned serialization envelope. The version is *also* baked into the key
 * prefix (see `Cache.qualify`), so a version bump abandons old keys wholesale;
 * the `v` guard here is a second line of defense that rejects any value whose
 * shape does not match the current reader (treated as a miss).
 */
interface Envelope<T> {
  v: number;
  d: T;
}

export interface CacheOptions {
  store: CacheStore;
  logger: Logger;
  /** Master switch; when false every read misses and every write is skipped. */
  enabled: boolean;
  /** Key namespace root, e.g. "berry". */
  keyPrefix: string;
  /** Serialization/version tag baked into every key and envelope. */
  schemaVersion: number;
  /** Fallback TTL (seconds) for `getOrLoad`/`set` calls that pass none. */
  defaultTtlSeconds: number;
}

export interface GetOrLoadOptions {
  /** TTL in seconds for this entry; falls back to `defaultTtlSeconds`. */
  ttlSeconds?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Backend errors swallowed by fail-open (read or write). */
  errors: number;
  /** Values dropped because they failed to deserialize / version-mismatched. */
  malformed: number;
}

/**
 * Cache-aside over a `CacheStore` (ADR-0002).
 *
 * Every operation fails open: a Valkey error, timeout, or malformed value is
 * logged and treated as a miss, so the caller always falls through to the
 * authoritative loader. Valkey is never the system of record.
 *
 * `getOrLoad` additionally coalesces concurrent identical loads within this
 * process (single-flight), so a burst of hot-read requests during a cold key
 * triggers exactly one loader instead of a stampede.
 */
export class Cache {
  private readonly store: CacheStore;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly head: string;
  private readonly schemaVersion: number;
  private readonly defaultTtlSeconds: number;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly stats: CacheStats = { hits: 0, misses: 0, errors: 0, malformed: 0 };

  constructor(options: CacheOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.enabled = options.enabled;
    this.schemaVersion = options.schemaVersion;
    this.defaultTtlSeconds = options.defaultTtlSeconds;
    this.head = `${options.keyPrefix}:cache:v${options.schemaVersion}:`;
  }

  /** Prepend the versioned namespace head to a logical key. */
  private qualify(logicalKey: string): string {
    return `${this.head}${logicalKey}`;
  }

  private serialize<T>(value: T): string {
    const envelope: Envelope<T> = { v: this.schemaVersion, d: value };
    return JSON.stringify(envelope);
  }

  /** Parse a stored string back to its value, or null if absent/malformed/stale-version. */
  private deserialize<T>(raw: string | null): { value: T } | null {
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.stats.malformed++;
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Envelope<T>).v !== this.schemaVersion ||
      !("d" in parsed)
    ) {
      this.stats.malformed++;
      return null;
    }
    return { value: (parsed as Envelope<T>).d };
  }

  /**
   * Read `logicalKey`; on a miss (or any cache failure) run `loader`, cache its
   * result, and return it. The loader's result is always returned even if the
   * cache write fails.
   */
  async getOrLoad<T>(
    logicalKey: string,
    loader: () => Promise<T>,
    options: GetOrLoadOptions = {},
  ): Promise<T> {
    if (!this.enabled) return loader();

    const cached = await this.get<T>(logicalKey);
    if (cached !== undefined) return cached;

    // Single-flight: coalesce concurrent identical cold loads in this process.
    const existing = this.inFlight.get(logicalKey);
    if (existing) return existing as Promise<T>;

    const ttl = options.ttlSeconds ?? this.defaultTtlSeconds;
    const promise = (async () => {
      const value = await loader();
      await this.set(logicalKey, value, { ttlSeconds: ttl });
      return value;
    })().finally(() => {
      this.inFlight.delete(logicalKey);
    });

    this.inFlight.set(logicalKey, promise);
    return promise;
  }

  /**
   * Read a value from the cache. Returns `undefined` on a miss, on a malformed
   * value, or on any backend failure (fail-open) — never throws. `undefined` is
   * the miss sentinel, distinct from a cached JSON `null`.
   */
  async get<T>(logicalKey: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    try {
      const raw = await this.store.get(this.qualify(logicalKey));
      const hit = this.deserialize<T>(raw);
      if (hit) {
        this.stats.hits++;
        return hit.value;
      }
      this.stats.misses++;
      return undefined;
    } catch (error) {
      this.stats.errors++;
      this.logger.debug({ err: error, key: logicalKey }, "cache: read failed, treating as miss");
      return undefined;
    }
  }

  /** Write a value. Swallows backend failures (fail-open); never throws. */
  async set<T>(logicalKey: string, value: T, options: GetOrLoadOptions = {}): Promise<void> {
    if (!this.enabled) return;
    const ttl = options.ttlSeconds ?? this.defaultTtlSeconds;
    try {
      await this.store.set(this.qualify(logicalKey), this.serialize(value), ttl);
    } catch (error) {
      this.stats.errors++;
      this.logger.debug({ err: error, key: logicalKey }, "cache: write failed");
    }
  }

  /** Invalidate one or more exact logical keys. Swallows backend failures. */
  async invalidate(...logicalKeys: string[]): Promise<void> {
    if (!this.enabled || logicalKeys.length === 0) return;
    try {
      await this.store.del(logicalKeys.map((key) => this.qualify(key)));
    } catch (error) {
      this.stats.errors++;
      this.logger.debug({ err: error, keys: logicalKeys }, "cache: invalidate failed");
    }
  }

  /**
   * Invalidate every key under a logical prefix — used to drop all cached pages
   * of a list when any member changes. Returns the number removed (0 on failure).
   */
  async invalidateByPrefix(logicalPrefix: string): Promise<number> {
    if (!this.enabled) return 0;
    try {
      return await this.store.delByPrefix(this.qualify(logicalPrefix));
    } catch (error) {
      this.stats.errors++;
      this.logger.debug({ err: error, prefix: logicalPrefix }, "cache: prefix invalidate failed");
      return 0;
    }
  }

  /** Liveness probe of the backing store; false on any failure. */
  async healthy(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      return await this.store.ping();
    } catch {
      return false;
    }
  }

  /** Snapshot of hit/miss/error counters for observability. */
  getStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
