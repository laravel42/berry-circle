import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session token primitives.
 *
 * The raw token is shown to the client exactly once (at login) and is what the
 * client sends as `Authorization: Bearer <token>`. Only its SHA-256 hash is
 * ever persisted (`sessions.token_hash`), so a database leak does not hand an
 * attacker usable tokens. Lookups hash the presented token and match on the
 * hash column, which is unique-indexed.
 */

/** Bytes of entropy in a session token (256 bits). */
const TOKEN_BYTES = 32;

/** Generates a new high-entropy, URL-safe session token. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Returns the hex SHA-256 hash of a token, as stored in `sessions.token_hash`. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two token hashes. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts a bearer token from an `Authorization` header value.
 * Returns null when the header is missing or not a non-empty `Bearer` token.
 */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
