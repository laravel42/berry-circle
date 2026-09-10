import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer credential primitives.
 *
 * The parsing rules here are deliberately strict and are load-bearing: scheme
 * casing, extra whitespace, base64 padding and additional credentials are all
 * rejected, so every malformed credential produces the same result and none of
 * them is distinguishable from any other. The retired Bun gateway accepted
 * `/^Bearer[ ]+(.+)$/i`, which is a different and weaker contract; this is the
 * Go one, unchanged, because the sessions it reads were issued under it.
 */

const TOKEN_BYTES = 32;
const PERSONAL_TOKEN_ID_BYTES = 12;
export const PERSONAL_TOKEN_PREFIX = 'berry_pat_';
const PERSONAL_TOKEN_SEPARATOR = '_';

/** Length of `n` bytes encoded as unpadded base64url, matching Go's EncodedLen. */
function encodedLength(bytes: number): number {
   return Math.ceil((bytes * 8) / 6);
}

const SESSION_TOKEN_LENGTH = encodedLength(TOKEN_BYTES);
const PERSONAL_ID_LENGTH = encodedLength(PERSONAL_TOKEN_ID_BYTES);

/** Raised for every credential that fails to parse, whatever the reason. */
export class Unauthenticated extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'Unauthenticated';
   }
}

export interface GeneratedPersonalToken {
   /** Shown once, never stored. */
   token: string;
   /** Indexed, so verification is one lookup rather than a scan. */
   publicId: string;
   /** The only part persisted. */
   secretHash: Buffer;
}

/** 256 bits as unpadded base64url. */
export function generateToken(random: (size: number) => Buffer = randomBytes): string {
   return random(TOKEN_BYTES).toString('base64url');
}

/** The lowercase SHA-256 hex persisted in `sessions.token_hash`. */
export function hashToken(token: string): string {
   return createHash('sha256').update(token).digest('hex');
}

/** The binary SHA-256 digest used by one-time secret stores. */
export function digestToken(token: string): Buffer {
   return createHash('sha256').update(token).digest();
}

/**
 * Builds `berry_pat_<publicId>_<secret>`.
 *
 * Split so the public half can be indexed: verification finds the row by
 * `publicId` and then compares the secret's digest, rather than hashing every
 * candidate token in the table.
 */
export function generatePersonalToken(
   random: (size: number) => Buffer = randomBytes
): GeneratedPersonalToken {
   const publicId = random(PERSONAL_TOKEN_ID_BYTES).toString('base64url');
   const secret = random(TOKEN_BYTES).toString('base64url');
   return {
      token: PERSONAL_TOKEN_PREFIX + publicId + PERSONAL_TOKEN_SEPARATOR + secret,
      publicId,
      secretHash: digestToken(secret),
   };
}

/** Whether a credential claims Berry's PAT namespace, well-formed or not. */
export function isPersonalToken(token: string): boolean {
   return token.startsWith(PERSONAL_TOKEN_PREFIX);
}

/**
 * Splits a personal token into its public identifier and secret.
 *
 * A token that claims the namespace and fails here is refused outright — it
 * must never fall through to session verification, or a malformed PAT would be
 * looked up as though it were a session token.
 *
 * Succeeding here is a shape check, not authentication: the caller still has
 * to find `publicId` and match the secret's digest.
 */
export function parsePersonalToken(token: string): { publicId: string; secret: string } {
   if (!isPersonalToken(token)) throw new Unauthenticated();
   const remainder = token.slice(PERSONAL_TOKEN_PREFIX.length);

   // Split on position rather than on the first separator. Both halves are
   // base64url and that alphabet includes '_', so searching for one lands
   // inside the public identifier whenever it happens to contain a separator.
   // Both halves are fixed width, so the index is known.
   if (
      remainder.length !== PERSONAL_ID_LENGTH + PERSONAL_TOKEN_SEPARATOR.length + SESSION_TOKEN_LENGTH ||
      !remainder.startsWith(PERSONAL_TOKEN_SEPARATOR, PERSONAL_ID_LENGTH)
   ) {
      throw new Unauthenticated();
   }
   const publicId = remainder.slice(0, PERSONAL_ID_LENGTH);
   const secret = remainder.slice(PERSONAL_ID_LENGTH + PERSONAL_TOKEN_SEPARATOR.length);

   if (!decodesTo(publicId, PERSONAL_TOKEN_ID_BYTES) || !decodesTo(secret, TOKEN_BYTES)) {
      throw new Unauthenticated();
   }
   return { publicId, secret };
}

/**
 * Accepts exactly one strict session or personal bearer credential.
 *
 * `strings.Count(header, " ") != 1` in Go — the header must contain the single
 * space that follows the scheme and no other. That rejects `Bearer  x`,
 * `bearer x`, and `Bearer x y` alike.
 */
export function parseAuthorization(header: string | undefined | null): string {
   if (!header || !header.startsWith('Bearer ') || countSpaces(header) !== 1) {
      throw new Unauthenticated();
   }
   const token = header.slice('Bearer '.length);

   if (isPersonalToken(token)) {
      parsePersonalToken(token);
      return token;
   }
   if (token.length !== SESSION_TOKEN_LENGTH || !decodesTo(token, TOKEN_BYTES)) {
      throw new Unauthenticated();
   }
   return token;
}

/** The token characters a bearer may carry: RFC 6750's b64token, bounded. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/**
 * Accepts exactly one strict bearer credential of any registered kind.
 *
 * Unlike {@link parseAuthorization} it does not insist on a session-shaped
 * token: sessions are cookies now, and a bearer is a personal token or
 * whatever another resolver registers (a task token). The scheme rules are
 * the same and just as strict, so every malformed header is refused alike;
 * which resolver owns the token is decided by the caller.
 */
export function parseBearer(header: string | undefined | null): string {
   if (!header || !header.startsWith('Bearer ') || countSpaces(header) !== 1) {
      throw new Unauthenticated();
   }
   const token = header.slice('Bearer '.length);
   if (!BEARER_TOKEN.test(token)) throw new Unauthenticated();
   if (isPersonalToken(token)) parsePersonalToken(token);
   return token;
}

/** Constant-time digest comparison, for verifying a presented PAT secret. */
export function secretMatches(secret: string, expected: Buffer): boolean {
   const actual = digestToken(secret);
   return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Whether a string is exactly `bytes` of unpadded base64url.
 *
 * Node's base64url decoder is lenient where Go's is not: it ignores characters
 * it does not recognise rather than failing, so a token containing `+`, `/` or
 * `=` would decode to the right length and pass. Re-encoding and comparing is
 * what makes the check as strict as `base64.RawURLEncoding.DecodeString`.
 */
function decodesTo(value: string, bytes: number): boolean {
   const decoded = Buffer.from(value, 'base64url');
   return decoded.length === bytes && decoded.toString('base64url') === value;
}

function countSpaces(value: string): number {
   let count = 0;
   for (const character of value) if (character === ' ') count += 1;
   return count;
}
