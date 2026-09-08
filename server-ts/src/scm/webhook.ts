import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * Accepting what the git host tells us, at most once, and only when it is news.
 *
 * Three separate protections, because they guard three different failures:
 *
 *   - **Signature** — anyone can POST to this route. Without it, a stranger
 *     could close every task in a workspace.
 *   - **Delivery id** — hosts retry, and a retried delivery is the same fact
 *     arriving twice, not a second fact.
 *   - **Freshness** — Berry writes to the host, the host tells Berry about the
 *     write, and applying it again is the loop this integration would otherwise
 *     have. Broken by comparing the payload's timestamp against what Berry
 *     recorded when it made the change.
 *
 * Only the third is specific to a two-way integration, and it is the one that
 * cannot be added later without rewriting the handlers.
 */

/**
 * Whether the body carries this secret's signature.
 *
 * GitHub signs the raw body with HMAC-SHA256 and sends it in
 * `X-Hub-Signature-256` as `sha256=<hex>`. The prefix is stripped rather than
 * required, so a bare hex digest is still accepted — the signature is what is
 * being checked, not its packaging.
 *
 * Compared in constant time: a byte-by-byte comparison that returns early
 * leaks how much of a guess was right.
 */
export function verifySignature(body: string, signature: string, secret: string): boolean {
   if (!signature || !secret) return false;
   const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
   const hex = signature.trim().replace(/^sha256=/i, '');
   let actual: Buffer;
   try {
      actual = Buffer.from(hex, 'hex');
   } catch {
      return false;
   }
   // timingSafeEqual throws on a length mismatch, which would itself be a
   // signal; the length is checked first and the result is the same answer.
   return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class WebhookDeliveries {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   /**
    * Records a delivery, answering whether it is the first sight of it.
    *
    * The insert is the claim: `ON CONFLICT DO NOTHING` means two concurrent
    * deliveries of the same event race to insert and exactly one wins, which is
    * the property a check-then-act pair does not have.
    */
   async firstSeen(input: {
      provider: string;
      deliveryId: string;
      eventType: string;
      workspaceId?: string | null;
   }): Promise<boolean> {
      const rows = await this.#sql`
         INSERT INTO integration_webhook_deliveries (provider, delivery_id, event_type, workspace_id)
         VALUES (${input.provider}, ${input.deliveryId.slice(0, 200)}, ${input.eventType},
                 ${input.workspaceId ?? null})
         ON CONFLICT (provider, delivery_id) DO NOTHING
         RETURNING id`;
      return rows.length > 0;
   }

   /** Drops deliveries older than the retention window. */
   async prune(olderThan: string): Promise<number> {
      const rows = await this.#sql`
         DELETE FROM integration_webhook_deliveries
          WHERE received_at < ${olderThan} RETURNING 1`;
      return rows.length;
   }
}
