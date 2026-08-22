import { createHash } from "node:crypto";

/**
 * Cache key registry (ADR-0002).
 *
 * ADR-0002 requires every cache key to have a documented owner, namespace,
 * serialization version, and expiry. This module owns the *logical* key shape
 * (namespace + identity); the `<prefix>:cache:v<version>:` head and the TTL are
 * applied by the `Cache` layer from `cacheConfig`. See `README.md` in this
 * directory for the full owner/TTL/invalidation table.
 *
 * | Namespace       | Identity                    | Owner        | Invalidated on            |
 * |-----------------|-----------------------------|--------------|---------------------------|
 * | `board`         | boardId                     | BERR-23      | board update              |
 * | `boards:list`   | query params                | BERR-23      | any board create/update   |
 * | `issue`         | issueId                     | BERR-23      | issue update              |
 * | `issues:list`   | boardId + query params      | BERR-23      | any issue create/update   |
 *
 * `boards:list` and `issues:list` are page caches keyed by their query
 * parameters. Because different parameter sets MUST NOT collide onto the same
 * key (that would serve one filter's page to another), the parameter fingerprint
 * uses SHA-256 rather than a fast lossy hash. `boardId` is kept in the clear in
 * the `issues:list` key so a single board's issue pages can be invalidated with
 * one prefix scan without touching other boards.
 */

export type CacheParams = Record<string, unknown>;

/**
 * Canonical, order-independent fingerprint of a set of query parameters.
 *
 * Keys are sorted; `undefined`/`null` values are dropped (an absent filter and
 * an explicitly-null filter address the same cached page); array values are
 * serialized in place (callers that treat arrays as sets should pre-sort). The
 * result is a 32-hex-char (128-bit) SHA-256 prefix — collision-safe for our
 * parameter space while keeping keys short.
 */
export function fingerprint(params: CacheParams = {}): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    normalized[key] = value;
  }
  const canonical = JSON.stringify(normalized);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// ---------- single-resource keys ----------

export function boardKey(boardId: string): string {
  return `board:${boardId}`;
}

export function issueKey(issueId: string): string {
  return `issue:${issueId}`;
}

// ---------- list (page) keys ----------

export function boardsListKey(params: CacheParams = {}): string {
  return `boards:list:${fingerprint(params)}`;
}

export function issueListKey(boardId: string, params: CacheParams = {}): string {
  return `issues:list:${boardId}:${fingerprint(params)}`;
}

// ---------- invalidation prefixes ----------
//
// Prefixes are matched against the *logical* key (the Cache layer prepends the
// versioned head before scanning). A trailing separator keeps `boards:list:`
// from also matching a hypothetical `boards:listing:` namespace.

export function boardsListPrefix(): string {
  return "boards:list:";
}

export function issueListPrefix(boardId: string): string {
  return `issues:list:${boardId}:`;
}
