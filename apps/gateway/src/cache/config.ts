import { z } from "zod";

/**
 * Cache configuration (ADR-0002).
 *
 * Kept in its own module rather than folded into `~/config` so the caching
 * layer stays self-contained and independently testable, and so this file can
 * be merged without contending with the other gateway sub-issues that also
 * touch the central env schema. `loadCacheConfig` mirrors the shape and
 * error-reporting of `loadConfig` in `~/config`.
 *
 * TTLs are configurable per hot-read family; every value has a working default
 * so a fresh checkout caches sensibly with no extra env.
 */
const cacheEnvSchema = z.object({
  // Master switch. When false the gateway behaves exactly as if Valkey were
  // permanently unavailable: every read is a miss and every write is a no-op,
  // so correctness never depends on the cache being on.
  CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Valkey/Redis connection string. Valkey speaks the Redis wire protocol, so
  // the `redis://` scheme is correct. Loopback default matches docker-compose
  // (VALKEY_PORT), which binds Valkey to 127.0.0.1 only.
  VALKEY_URL: z.string().url().default("redis://127.0.0.1:6379"),

  // Key namespace root. Combined with the schema version to form the prefix
  // `<prefix>:cache:v<version>:` on every key, giving each tenant/deploy a
  // clean, collision-free keyspace.
  CACHE_KEY_PREFIX: z.string().min(1).default("berry"),

  // Serialization/version tag baked into every key. Bump this to invalidate the
  // entire cache atomically after an incompatible payload-shape change; old
  // keys are simply never read again and expire on their own TTL.
  CACHE_SCHEMA_VERSION: z.coerce.number().int().positive().default(1),

  // Per-operation timeout guard (ms). A cache op that outlives this is abandoned
  // and treated as a miss so a slow/hung Valkey can never stall a request.
  CACHE_OP_TIMEOUT_MS: z.coerce.number().int().positive().default(250),

  // TTLs in seconds, per hot-read family. Fallback for any key with no explicit
  // TTL is CACHE_TTL_DEFAULT_SECONDS.
  CACHE_TTL_DEFAULT_SECONDS: z.coerce.number().int().positive().default(30),
  CACHE_TTL_BOARD_SECONDS: z.coerce.number().int().positive().default(60),
  CACHE_TTL_BOARDS_LIST_SECONDS: z.coerce.number().int().positive().default(30),
  CACHE_TTL_ISSUE_SECONDS: z.coerce.number().int().positive().default(30),
  CACHE_TTL_ISSUE_LIST_SECONDS: z.coerce.number().int().positive().default(15),
});

export type CacheConfig = z.infer<typeof cacheEnvSchema>;

export function loadCacheConfig(
  env: Record<string, string | undefined> = process.env,
): CacheConfig {
  const parsed = cacheEnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid cache configuration for: ${fields}`);
  }
  return parsed.data;
}

export const cacheConfig = loadCacheConfig();
