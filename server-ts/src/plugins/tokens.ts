import { randomBytes } from 'node:crypto';
import { digestToken, Unauthenticated } from '../auth/tokens.ts';

/**
 * `berry_plg_<publicId>_<secret>`: the same fixed-width shape as a personal
 * token, in its own namespace, so the public API can tell the two apart by
 * prefix and index the public half.
 */

export const PLUGIN_TOKEN_PREFIX = 'berry_plg_';
const SIGNING_PREFIX = 'berry_whsec_';
const ID_BYTES = 12;
const SECRET_BYTES = 32;
const ID_LENGTH = 16;
const SECRET_LENGTH = 43;

export interface GeneratedPluginToken {
   token: string;
   publicId: string;
   secretHash: Buffer;
}

export function generatePluginToken(
   random: (size: number) => Buffer = randomBytes
): GeneratedPluginToken {
   const publicId = random(ID_BYTES).toString('base64url');
   const secret = random(SECRET_BYTES).toString('base64url');
   return {
      token: `${PLUGIN_TOKEN_PREFIX}${publicId}_${secret}`,
      publicId,
      secretHash: digestToken(secret),
   };
}

export function isPluginToken(token: string): boolean {
   return token.startsWith(PLUGIN_TOKEN_PREFIX);
}

/** Split by position: both halves are base64url, whose alphabet includes '_'. */
export function parsePluginToken(token: string): { publicId: string; secret: string } {
   if (!isPluginToken(token)) throw new Unauthenticated();
   const rest = token.slice(PLUGIN_TOKEN_PREFIX.length);
   if (rest.length !== ID_LENGTH + 1 + SECRET_LENGTH || rest[ID_LENGTH] !== '_') {
      throw new Unauthenticated();
   }
   const publicId = rest.slice(0, ID_LENGTH);
   const secret = rest.slice(ID_LENGTH + 1);
   if (!decodesTo(publicId, ID_BYTES) || !decodesTo(secret, SECRET_BYTES)) {
      throw new Unauthenticated();
   }
   return { publicId, secret };
}

/** The HMAC key a plugin verifies Berry's calls with. Shown once, stored sealed. */
export function generateSigningSecret(random: (size: number) => Buffer = randomBytes): string {
   return SIGNING_PREFIX + random(SECRET_BYTES).toString('base64url');
}

/** Node's decoder skips unknown characters; re-encoding makes the check strict. */
function decodesTo(value: string, bytes: number): boolean {
   const decoded = Buffer.from(value, 'base64url');
   return decoded.length === bytes && decoded.toString('base64url') === value;
}
