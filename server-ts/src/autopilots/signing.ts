import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * What makes an autopilot webhook safe to leave on the public internet.
 *
 * The token in the URL says which trigger is meant; it is stored only as a
 * SHA-256 hash, so a database read does not hand anyone a working URL. The
 * signing secret proves the sender knows it: the raw body is signed with
 * HMAC-SHA256 and sent as `X-Berry-Signature: sha256=<hex>`, the same
 * packaging GitHub uses, so the constant-time check in scm/webhook serves
 * both.
 */

export { verifySignature } from '../scm/webhook.ts';

export const SIGNATURE_HEADER = 'x-berry-signature';
export const EVENT_HEADER = 'x-berry-event';

const TOKEN_SHAPE = /^apw_[A-Za-z0-9_-]{32}$/;

export function newWebhookToken(): string {
   return `apw_${randomBytes(24).toString('base64url')}`;
}

export function validTokenShape(token: string): boolean {
   return TOKEN_SHAPE.test(token);
}

export function newSigningSecret(): string {
   return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
   return createHash('sha256').update(token, 'utf8').digest();
}

export function tokenHint(token: string): string {
   return token.slice(-4);
}

export function signBody(body: string, secret: string): string {
   return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}
