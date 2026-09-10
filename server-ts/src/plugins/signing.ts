import { createHmac } from 'node:crypto';

/**
 * How a plugin knows a call came from Berry: an HMAC over the timestamp and
 * the exact body bytes, under the signing secret shown once at install. The
 * timestamp lets the plugin refuse replays (the SDK allows five minutes).
 */

export const SIGNATURE_HEADER = 'Berry-Signature';

export function signPayload(secret: string, timestamp: number, body: string): string {
   const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
   return `t=${timestamp},v1=${digest}`;
}
