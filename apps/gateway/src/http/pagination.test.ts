import { describe, expect, test } from "bun:test";
import { ApiError } from "~/http/errors";
import {
  buildConnection,
  decodeCursor,
  encodeCursor,
  pageArgsSchema,
  scopeKey,
} from "~/http/pagination";

describe("cursor codec", () => {
  test("round-trips a sort key within the same scope", () => {
    const scope = scopeKey("issues", "updatedAt:desc,id:desc", { boardId: "b1" });
    const key = ["2026-08-22T06:30:00.000Z", "8138a662-f20f-41aa-bd5a-cf46e35ba952"];
    expect(decodeCursor(scope, encodeCursor(scope, key))).toEqual(key);
  });

  test("rejects a cursor minted for a different endpoint", () => {
    const cursor = encodeCursor(scopeKey("issues", "s", { boardId: "b1" }), ["x", "y"]);
    expect(() => decodeCursor(scopeKey("issue-comments", "s", { boardId: "b1" }), cursor)).toThrow(
      ApiError,
    );
  });

  test("rejects a cursor minted for a different filter set", () => {
    const cursor = encodeCursor(scopeKey("issues", "s", { status: ["todo"] }), ["x", "y"]);
    let code: string | undefined;
    try {
      decodeCursor(scopeKey("issues", "s", { status: ["done"] }), cursor);
    } catch (err) {
      code = (err as ApiError).code;
    }
    expect(code).toBe("INVALID_CURSOR");
  });

  test("rejects a structurally invalid cursor", () => {
    expect(() => decodeCursor("scope", "not-base64-$$$")).toThrow(ApiError);
  });
});

describe("scopeKey", () => {
  test("is filter-order independent and ignores empty filters", () => {
    const a = scopeKey("issues", "s", {
      boardId: "b1",
      status: ["todo", "done"],
      query: undefined,
    });
    const b = scopeKey("issues", "s", { status: ["done", "todo"], boardId: "b1" });
    expect(a).toBe(b);
  });

  test("differs when a filter value differs", () => {
    expect(scopeKey("issues", "s", { boardId: "b1" })).not.toBe(
      scopeKey("issues", "s", { boardId: "b2" }),
    );
  });
});

describe("buildConnection", () => {
  const scope = scopeKey("issues", "s", {});
  const toNode = (n: number) => ({ n });
  const toKey = (n: number) => [String(n)];

  test("drops the probe row and reports hasNextPage when over-fetched", () => {
    const conn = buildConnection([1, 2, 3], 2, scope, toNode, toKey);
    expect(conn.nodes).toEqual([{ n: 1 }, { n: 2 }]);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.pageInfo.endCursor).toBe(encodeCursor(scope, ["2"]));
  });

  test("no next page and endCursor of last node when exactly filled", () => {
    const conn = buildConnection([1, 2], 2, scope, toNode, toKey);
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.endCursor).toBe(encodeCursor(scope, ["2"]));
  });

  test("empty page yields a null endCursor", () => {
    const conn = buildConnection([], 2, scope, toNode, toKey);
    expect(conn.nodes).toEqual([]);
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });
});

describe("pageArgsSchema", () => {
  test("defaults first to 50", () => {
    expect(pageArgsSchema.parse({}).first).toBe(50);
  });

  test("coerces and bounds first to 1..100", () => {
    expect(pageArgsSchema.parse({ first: "10" }).first).toBe(10);
    expect(pageArgsSchema.safeParse({ first: "0" }).success).toBe(false);
    expect(pageArgsSchema.safeParse({ first: "101" }).success).toBe(false);
  });
});
