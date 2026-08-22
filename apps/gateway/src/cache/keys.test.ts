import { describe, expect, it } from "bun:test";
import {
  boardKey,
  boardsListKey,
  boardsListPrefix,
  fingerprint,
  issueKey,
  issueListKey,
  issueListPrefix,
} from "~/cache/keys";

describe("fingerprint", () => {
  it("is stable and independent of key insertion order", () => {
    expect(fingerprint({ first: 50, status: ["todo"] })).toBe(
      fingerprint({ status: ["todo"], first: 50 }),
    );
  });

  it("ignores undefined values but preserves explicit null filters", () => {
    expect(fingerprint({ first: 50, after: undefined })).toBe(fingerprint({ first: 50 }));
    expect(fingerprint({ first: 50, query: null })).not.toBe(fingerprint({ first: 50 }));
  });

  it("distinguishes different parameter values", () => {
    expect(fingerprint({ first: 50 })).not.toBe(fingerprint({ first: 100 }));
    expect(fingerprint({ status: ["todo"] })).not.toBe(fingerprint({ status: ["done"] }));
  });

  it("produces a bounded, url-safe hex token", () => {
    expect(fingerprint({ query: "x".repeat(500) })).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a stable token for empty params", () => {
    expect(fingerprint()).toBe(fingerprint({}));
  });
});

describe("resource keys", () => {
  it("namespaces single resources by id", () => {
    expect(boardKey("b1")).toBe("board:b1");
    expect(issueKey("i1")).toBe("issue:i1");
  });

  it("keeps boardId in the clear in issue-list keys for scoped invalidation", () => {
    const key = issueListKey("b1", { first: 50 });
    expect(key.startsWith("issues:list:b1:")).toBe(true);
    expect(key.startsWith(issueListPrefix("b1"))).toBe(true);
  });

  it("issue-list keys for different boards do not collide", () => {
    expect(issueListKey("b1", { first: 50 })).not.toBe(issueListKey("b2", { first: 50 }));
  });

  it("boards-list keys share the list prefix", () => {
    expect(boardsListKey({ first: 50 }).startsWith(boardsListPrefix())).toBe(true);
  });
});

describe("invalidation prefixes", () => {
  it("scope a single board's issue pages without touching siblings", () => {
    const b1 = issueListPrefix("b1");
    expect(issueListKey("b1", { first: 50 }).startsWith(b1)).toBe(true);
    expect(issueListKey("b2", { first: 50 }).startsWith(b1)).toBe(false);
  });

  it("boards-list prefix matches every boards-list page", () => {
    const prefix = boardsListPrefix();
    expect(boardsListKey({ first: 1 }).startsWith(prefix)).toBe(true);
    expect(boardsListKey({ first: 100, after: "cur" }).startsWith(prefix)).toBe(true);
  });
});
