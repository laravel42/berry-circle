import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Berry-Signature';

/** Checks `t=<seconds>,v1=<hex>` over the exact body bytes, within a replay window. */
export function verifySignature(input: {
   secret: string;
   header: string | null;
   body: string;
   now?: number;
   toleranceSeconds?: number;
}): boolean {
   if (!input.header) return false;
   const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(input.header);
   if (!match) return false;
   const timestamp = Number(match[1]);
   const now = input.now ?? Math.floor(Date.now() / 1000);
   if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return false;
   const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest();
   const given = Buffer.from(match[2] ?? '', 'hex');
   return given.length === expected.length && timingSafeEqual(given, expected);
}
