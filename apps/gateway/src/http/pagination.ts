import { z } from "zod";
import { invalidCursor } from "~/http/errors";

/**
 * Opaque keyset (seek) pagination, per the M0 contract: cursors encode the
 * final stable sort tuple plus a fingerprint of the endpoint + effective
 * filters + sort. A cursor replayed against a different endpoint, filter set,
 * or sort is rejected with `400 INVALID_CURSOR`, and paging never produces
 * duplicate nodes across adjacent pages.
 */

/** The trailing sort-key tuple of a page's last node, e.g. `[updatedAtIso, id]`. */
export type SortKey = (string | number)[];

interface CursorPayload {
  v: 1;
  /** Scope fingerprint: endpoint + sort + normalized filters. */
  s: string;
  /** Sort-key tuple. */
  k: SortKey;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** `first` / `after` collection parameters, shared by every list endpoint. */
export const pageArgsSchema = z.object({
  first: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  after: z.string().min(1).optional(),
});

export type PageArgs = z.infer<typeof pageArgsSchema>;

export interface Connection<Node> {
  nodes: Node[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

/**
 * A stable fingerprint of the query's shape. Two requests share a scope only
 * when their endpoint, sort, and (normalized) filters are identical, so a
 * cursor minted for one can never be spent on another.
 */
export function scopeKey(endpoint: string, sort: string, filters: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const name of Object.keys(filters).sort()) {
    const value = filters[name];
    if (value === undefined || value === null) continue;
    normalized[name] = Array.isArray(value) ? [...value].map(String).sort() : String(value);
  }
  return JSON.stringify({ endpoint, sort, filters: normalized });
}

export function encodeCursor(scope: string, key: SortKey): string {
  const payload: CursorPayload = { v: 1, s: scope, k: key };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes a cursor and verifies it belongs to `scope`, or throws
 * `400 INVALID_CURSOR`. */
export function decodeCursor(scope: string, cursor: string): SortKey {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as CursorPayload).v !== 1 ||
    (payload as CursorPayload).s !== scope ||
    !Array.isArray((payload as CursorPayload).k)
  ) {
    throw invalidCursor();
  }
  return (payload as CursorPayload).k;
}

/**
 * Builds a connection from rows fetched with `limit = first + 1`: the extra row
 * (if present) proves another page exists and is dropped from the response.
 */
export function buildConnection<Row, Node>(
  rows: Row[],
  first: number,
  scope: string,
  toNode: (row: Row) => Node,
  toKey: (row: Row) => SortKey,
): Connection<Node> {
  const hasNextPage = rows.length > first;
  const page = hasNextPage ? rows.slice(0, first) : rows;
  const last = page.at(-1);
  return {
    nodes: page.map(toNode),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor(scope, toKey(last)) : null,
    },
  };
}
