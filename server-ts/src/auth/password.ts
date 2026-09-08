import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * scrypt parameters, OWASP-aligned for interactive login.
 *
 * `N=2^15` with `r=8, p=1` derives a 32-byte key from a 16-byte per-user salt.
 * Declared as a `const` object (not an `enum`) so the module stays within
 * `erasableSyntaxOnly` and the values are inlined at the single call site.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32, saltBytes: 16 } as const;

/**
 * scrypt with `N=32768` needs more working memory than Node's 32 MiB default,
 * so `maxmem` is raised. The lower bound scrypt requires is roughly
 * `128 * N * r` bytes; this leaves generous headroom for the parameters above.
 */
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

/**
 * A fixed salt used only for the dummy derivation `verifyPassword` performs when
 * no stored credential exists. Its value is irrelevant — it never matches a real
 * hash — but running a derivation against it keeps the unknown-email path the
 * same shape and duration as the wrong-password path (Requirements 1.4, 1.6).
 */
const DUMMY_SALT = Buffer.alloc(SCRYPT_PARAMS.saltBytes, 0);

export interface StoredPassword {
   /** Per user, stored in `users.password_salt` (bytea). */
   salt: Buffer;
   /** scrypt digest, stored in `users.password_hash` (bytea). */
   hash: Buffer;
}

/** Promisified scrypt with the parameters and raised `maxmem` above. */
function derive(password: string, salt: Buffer): Promise<Buffer> {
   return new Promise((resolve, reject) => {
      scryptCb(
         password,
         salt,
         SCRYPT_PARAMS.keyLen,
         { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_MAXMEM },
         (error, derivedKey) => {
            if (error) reject(error);
            else resolve(derivedKey);
         }
      );
   });
}

/** Derives a fresh salt+hash for a new or rotated password. */
export async function hashPassword(password: string): Promise<StoredPassword> {
   const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
   const hash = await derive(password, salt);
   return { salt, hash };
}

/**
 * Constant-time verify. Always runs a scrypt derivation — including a dummy one
 * against {@link DUMMY_SALT} when the user has no stored password — so timing
 * does not reveal whether an email is registered. "Unknown email" and "wrong
 * password" therefore take the same code path and the same time (Requirements
 * 1.2–1.4, 1.6).
 */
export async function verifyPassword(
   password: string,
   stored: StoredPassword | null
): Promise<boolean> {
   const salt = stored ? stored.salt : DUMMY_SALT;
   const derived = await derive(password, salt);
   if (!stored) return false;
   return derived.length === stored.hash.length && timingSafeEqual(derived, stored.hash);
}
