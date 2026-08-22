import { describe, expect, test } from "bun:test";
import { extractBearerToken, generateSessionToken, hashToken, tokenHashesEqual } from "./tokens";

describe("generateSessionToken", () => {
  test("produces unique, high-entropy URL-safe tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    // 32 random bytes as base64url = 43 chars, URL-safe alphabet only.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("hashToken", () => {
  test("is deterministic and never returns the raw token", () => {
    const token = generateSessionToken();
    const hash = hashToken(token);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
    // hex SHA-256.
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different tokens hash differently", () => {
    expect(hashToken(generateSessionToken())).not.toBe(hashToken(generateSessionToken()));
  });
});

describe("tokenHashesEqual", () => {
  test("matches equal hashes and rejects mismatches", () => {
    const hash = hashToken("token");
    expect(tokenHashesEqual(hash, hashToken("token"))).toBe(true);
    expect(tokenHashesEqual(hash, hashToken("other"))).toBe(false);
    expect(tokenHashesEqual(hash, "short")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  test("extracts the token from a well-formed header, case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("  Bearer   abc.def  ")).toBe("abc.def");
  });

  test("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Token abc")).toBeNull();
  });
});
