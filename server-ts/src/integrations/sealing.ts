import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credentials at rest.
 *
 * A provider token is the one thing Berry stores that grants access to somebody
 * else's system. It is sealed with AES-256-GCM before it reaches a column and
 * opened only at the moment it is used — never held in a row a query can
 * casually select into a log.
 *
 * The layout is the one already in the database, because rows sealed before
 * this code existed have to keep opening:
 *
 *   nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes)
 *
 * That is what Go's `gcm.Seal(nonce, nonce, plaintext, nil)` produces, and
 * `sealing.test.ts` opens a real row to prove the two agree.
 *
 * GCM is authenticated, so a tampered ciphertext fails to open rather than
 * decrypting to rubbish that a caller then sends to GitHub as a token.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SealingUnavailable extends Error {
   override readonly name = 'SealingUnavailable';
}

export class SealingFailed extends Error {
   override readonly name = 'SealingFailed';
}

export interface Sealer {
   seal(plaintext: string): Buffer;
   open(sealed: Buffer): string;
}

/**
 * Reads the key, or refuses.
 *
 * There is no generated fallback on purpose. A key that appeared on its own
 * would differ between restarts and strand every credential already stored —
 * the failure would look like "GitHub disconnected itself" rather than like a
 * missing setting.
 */
export function sealerFromKey(base64Key: string): Sealer {
   const key = decodeKey(base64Key);
   return {
      seal(plaintext: string): Buffer {
         const nonce = randomBytes(NONCE_BYTES);
         const cipher = createCipheriv('aes-256-gcm', key, nonce);
         const ciphertext = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
         ]);
         return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
      },

      open(sealed: Buffer): string {
         if (sealed.length < NONCE_BYTES + TAG_BYTES) {
            throw new SealingFailed('sealed value is too short to contain a nonce and a tag');
         }
         const nonce = sealed.subarray(0, NONCE_BYTES);
         const tag = sealed.subarray(sealed.length - TAG_BYTES);
         const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);

         const decipher = createDecipheriv('aes-256-gcm', key, nonce);
         decipher.setAuthTag(tag);
         try {
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
         } catch (cause) {
            // Deliberately says nothing about the value. A message that
            // distinguished "wrong key" from "tampered" would be an oracle,
            // and neither answer helps the operator more than this one.
            throw new SealingFailed('sealed value could not be opened', { cause });
         }
      },
   };
}

/**
 * A sealer that refuses, for a deployment with no key.
 *
 * Every call throws, so a caller has one failure mode rather than a `null` to
 * forget — and nothing can accidentally store a credential in the clear
 * because the key was missing.
 */
export function unavailableSealer(reason: string): Sealer {
   return {
      seal(): Buffer {
         throw new SealingUnavailable(reason);
      },
      open(): string {
         throw new SealingUnavailable(reason);
      },
   };
}

function decodeKey(base64Key: string): Buffer {
   const trimmed = base64Key.trim();
   if (trimmed === '') {
      throw new SealingUnavailable('INTEGRATION_ENCRYPTION_KEY is not set');
   }
   let key: Buffer;
   try {
      key = Buffer.from(trimmed, 'base64');
   } catch (cause) {
      throw new SealingUnavailable('INTEGRATION_ENCRYPTION_KEY is not valid base64', { cause });
   }
   if (key.length !== KEY_BYTES) {
      // Named without echoing the value: the length is the diagnosis, and the
      // key itself does not belong in a log line.
      throw new SealingUnavailable(
         `INTEGRATION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`
      );
   }
   return key;
}

/**
 * Whether two secrets are equal, without leaking where they differ.
 *
 * Exported here rather than reimplemented at each call site, because the
 * version someone writes in a hurry is `===`.
 */
export function secretsEqual(a: string, b: string): boolean {
   const left = Buffer.from(a, 'utf8');
   const right = Buffer.from(b, 'utf8');
   if (left.length !== right.length) return false;
   return timingSafeEqual(left, right);
}
