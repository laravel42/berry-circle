import { Cache } from "~/cache/cache";
import { cacheConfig } from "~/cache/config";
import {
  type CacheParams,
  boardKey,
  boardsListKey,
  boardsListPrefix,
  issueKey,
  issueListKey,
  issueListPrefix,
} from "~/cache/keys";
import { type CacheStore, NullStore, ValkeyStore } from "~/cache/store";
import { logger } from "~/logger";

/**
 * Cache-aside layer for the gateway's hot reads (ADR-0002 / BERR-25).
 *
 * Public entry points:
 *  - `cache`            — the shared {@link Cache} instance (get/set/invalidate/stats).
 *  - domain helpers     — `cacheBoard`, `cacheBoardsList`, `cacheIssue`,
 *                         `cacheIssueList` wrap a loader with the right key + TTL.
 *  - invalidation hooks — `invalidateBoard`, `invalidateIssue`, ... to call from writes.
 *  - `cacheHealth` / `closeCache` for wiring into health checks and shutdown.
 *
 * Read paths (BERR-23) adopt this by wrapping their DB loader:
 *   const board = await cacheBoard(id, () => db.loadBoard(id));
 * Write paths call the matching invalidation hook after a successful commit:
 *   await db.updateBoard(...); await invalidateBoard(id);
 */

const store: CacheStore = cacheConfig.CACHE_ENABLED
  ? new ValkeyStore({
      url: cacheConfig.VALKEY_URL,
      opTimeoutMs: cacheConfig.CACHE_OP_TIMEOUT_MS,
      logger,
    })
  : new NullStore();

export const cache = new Cache({
  store,
  logger,
  enabled: cacheConfig.CACHE_ENABLED,
  keyPrefix: cacheConfig.CACHE_KEY_PREFIX,
  schemaVersion: cacheConfig.CACHE_SCHEMA_VERSION,
  defaultTtlSeconds: cacheConfig.CACHE_TTL_DEFAULT_SECONDS,
});

// ---------- domain read helpers (cache-aside) ----------

/** Cache a single board by id. */
export function cacheBoard<T>(boardId: string, loader: () => Promise<T>): Promise<T> {
  return cache.getOrLoad(boardKey(boardId), loader, {
    ttlSeconds: cacheConfig.CACHE_TTL_BOARD_SECONDS,
  });
}

/** Cache a page of the boards list, keyed by its query parameters. */
export function cacheBoardsList<T>(params: CacheParams, loader: () => Promise<T>): Promise<T> {
  return cache.getOrLoad(boardsListKey(params), loader, {
    ttlSeconds: cacheConfig.CACHE_TTL_BOARDS_LIST_SECONDS,
  });
}

/** Cache a single issue by id. */
export function cacheIssue<T>(issueId: string, loader: () => Promise<T>): Promise<T> {
  return cache.getOrLoad(issueKey(issueId), loader, {
    ttlSeconds: cacheConfig.CACHE_TTL_ISSUE_SECONDS,
  });
}

/** Cache a page of a board's issue list, keyed by boardId + query parameters. */
export function cacheIssueList<T>(
  boardId: string,
  params: CacheParams,
  loader: () => Promise<T>,
): Promise<T> {
  return cache.getOrLoad(issueListKey(boardId, params), loader, {
    ttlSeconds: cacheConfig.CACHE_TTL_ISSUE_LIST_SECONDS,
  });
}

// ---------- invalidation hooks (call after a successful write) ----------

/**
 * Invalidate a board after it is created or updated: the board itself plus
 * every cached page of the boards list (its membership/ordering may have moved).
 */
export async function invalidateBoard(boardId: string): Promise<void> {
  await Promise.all([
    cache.invalidate(boardKey(boardId)),
    cache.invalidateByPrefix(boardsListPrefix()),
  ]);
}

/** Invalidate all cached pages of the boards list (e.g. on board creation). */
export async function invalidateBoardsList(): Promise<void> {
  await cache.invalidateByPrefix(boardsListPrefix());
}

/**
 * Invalidate an issue after it is created or updated: the issue itself plus
 * every cached issue-list page for its board (order/filters may have changed).
 */
export async function invalidateIssue(issueId: string, boardId: string): Promise<void> {
  await Promise.all([
    cache.invalidate(issueKey(issueId)),
    cache.invalidateByPrefix(issueListPrefix(boardId)),
  ]);
}

/** Invalidate all cached issue-list pages for a board (e.g. on issue creation). */
export async function invalidateIssuesForBoard(boardId: string): Promise<void> {
  await cache.invalidateByPrefix(issueListPrefix(boardId));
}

// ---------- lifecycle ----------

/** True when the cache is enabled and Valkey answered a ping. */
export function cacheHealth(): Promise<boolean> {
  return cache.healthy();
}

/** Close the backing connection. Call from graceful shutdown. Idempotent. */
export function closeCache(): Promise<void> {
  return cache.close();
}

export { Cache } from "~/cache/cache";
export type { CacheStats } from "~/cache/cache";
export * as cacheKeys from "~/cache/keys";
