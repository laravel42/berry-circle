import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { canonicalJSON, parseWithRawNumbers } from './canonical-json.ts';

/**
 * Durable idempotency claims.
 *
 * A claim is taken before the work runs and completed with the response, so a
 * retried request replays what the first one produced rather than doing it
 * twice. That matters most where the work is not undoable — dispatching a run,
 * charging for tokens, posting to a third party.
 *
 * The claim is a row, not a lock: it survives a restart, which an in-memory
 * map would not, and the window it protects can outlive the process.
 */

const LEASE_MS = 2 * 60 * 1000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPLAY_BODY = 1024 * 1024;

export type Decision = 'proceed' | 'replay' | 'conflict' | 'in-progress';

/** The complete namespace a key is unique within. */
export interface ActorScope {
   actorType: 'user' | 'agent';
   actorId: string;
   method: string;
   canonicalPath: string;
}

export interface StoredResponse {
   status: number;
   headers: Record<string, string[]>;
   body: string;
}

export interface ClaimResult {
   decision: Decision;
   claimId?: string;
   response?: StoredResponse;
}

export function validateIdempotencyKey(key: string): boolean {
   // Bytes, matching Go's len() on a string: a 128-character key of multi-byte
   // characters is longer than 128 bytes and is refused there too.
   const bytes = Buffer.byteLength(key, 'utf8');
   return bytes >= 16 && bytes <= 128 && /^[\x21-\x7e]+$/.test(key);
}

/**
 * Hashes a canonical form of the body, so whitespace and key order do not
 * make the same request look like a different one.
 *
 * The canonical form is not JavaScript's — see `canonical-json.ts`. It cannot
 * be: fingerprints of past requests are already stored, and a form that hashed
 * them differently would turn a legitimate replay into an IDEMPOTENCY_CONFLICT.
 *
 * Throws when the body is not exactly one JSON value — a caller sending
 * something unparseable has not made a request worth claiming a key for.
 */
export function fingerprintJSON(body: string): Buffer {
   return createHash('sha256').update(canonicalJSON(parseWithRawNumbers(body))).digest();
}

function validScope(scope: ActorScope): boolean {
   return (
      (scope.actorType === 'user' || scope.actorType === 'agent') &&
      scope.actorId !== '' &&
      scope.method !== '' &&
      scope.method === scope.method.toUpperCase() &&
      scope.canonicalPath.startsWith('/') &&
      scope.canonicalPath.length <= 2048
   );
}

/**
 * Only headers that are safe and meaningful to repeat.
 *
 * A replay must not resurrect the original's Set-Cookie or request id — the
 * body is the same answer, but the transport is a new exchange.
 */
const REPLAYABLE = new Set(['content-type', 'location', 'etag']);

export function replayHeaders(headers: Record<string, string[]>): Record<string, string[]> {
   const result: Record<string, string[]> = {};
   for (const [name, values] of Object.entries(headers)) {
      if (REPLAYABLE.has(name.toLowerCase())) result[canonical(name)] = [...values];
   }
   return result;
}

/** Headers are stored canonicalised, so a replay fingerprints to the same bytes. */
function canonical(name: string): string {
   return name
      .split('-')
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part))
      .join('-');
}

export class IdempotencyStore {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(sql: Sql, clock: () => Date = () => new Date(), newId = randomUUID) {
      this.sql = sql;
      this.clock = clock;
      this.newId = newId;
   }

   /**
    * Claims a key, or reports what the key already means.
    *
    * Four outcomes, and the distinction between the last two is the point:
    * a completed claim replays its stored response, while one still inside its
    * lease is another request in flight — answered 409 with Retry-After rather
    * than executed a second time.
    */
   async begin(scope: ActorScope, key: string, fingerprint: Buffer): Promise<ClaimResult> {
      if (!validScope(scope)) throw new Error('idempotency scope is invalid');
      if (!validateIdempotencyKey(key)) throw new Error('idempotency key is invalid');

      const now = this.clock();
      const nowIso = now.toISOString();
      const pathHash = createHash('sha256').update(scope.canonicalPath).digest();

      return this.sql.begin(async (tx) => {
         // An expired claim is removed first, so the key becomes usable again
         // rather than conflicting forever with a record nobody can replay.
         await tx`
            DELETE FROM idempotency_records
             WHERE actor_type = ${scope.actorType} AND actor_id = ${scope.actorId}
               AND method = ${scope.method} AND canonical_path_hash = ${pathHash}
               AND idempotency_key = ${key} AND expires_at <= ${nowIso}`;

         const claimId = this.newId();
         const inserted = await tx`
            INSERT INTO idempotency_records (
               id, actor_type, actor_id, method, canonical_path,
               canonical_path_hash, idempotency_key, fingerprint,
               lease_expires_at, expires_at
            ) VALUES (
               ${claimId}, ${scope.actorType}, ${scope.actorId}, ${scope.method},
               ${scope.canonicalPath}, ${pathHash}, ${key}, ${fingerprint},
               ${new Date(now.getTime() + LEASE_MS).toISOString()},
               ${new Date(now.getTime() + TTL_MS).toISOString()}
            )
            ON CONFLICT DO NOTHING
            RETURNING id`;
         if (inserted.length > 0) {
            return { decision: 'proceed' as const, claimId: inserted[0]!.id as string };
         }

         const [existing] = await tx`
            SELECT id, fingerprint, response_status,
                   COALESCE(response_headers, '{}'::jsonb) AS response_headers,
                   response_body, lease_expires_at
              FROM idempotency_records
             WHERE actor_type = ${scope.actorType} AND actor_id = ${scope.actorId}
               AND method = ${scope.method} AND canonical_path_hash = ${pathHash}
               AND idempotency_key = ${key}
             FOR UPDATE`;
         if (!existing) throw new Error('idempotency claim vanished');

         // The same key with a different body is a caller bug: answering with
         // the first response would silently discard the second request.
         if (!(existing.fingerprint as Buffer).equals(fingerprint)) {
            return { decision: 'conflict' as const };
         }

         if (existing.response_status !== null) {
            return {
               decision: 'replay' as const,
               response: {
                  status: existing.response_status as number,
                  headers: (existing.response_headers ?? {}) as Record<string, string[]>,
                  body: (existing.response_body as Buffer | null)?.toString('utf8') ?? '',
               },
            };
         }

         // A lease that has run out means the holder died mid-flight; take it
         // over rather than leaving the key unusable for its whole TTL.
         if (new Date(existing.lease_expires_at as string) <= now) {
            await tx`
               UPDATE idempotency_records
                  SET lease_expires_at = ${new Date(now.getTime() + LEASE_MS).toISOString()}
                WHERE id = ${existing.id as string}`;
            return { decision: 'proceed' as const, claimId: existing.id as string };
         }
         return { decision: 'in-progress' as const };
      });
   }

   /**
    * Stores the response for replay.
    *
    * A 5xx abandons the claim instead: the request failed for a reason that
    * may not recur, and pinning that failure for 24 hours would make a
    * transient fault permanent for anyone retrying with the same key.
    */
   async complete(claimId: string, response: StoredResponse): Promise<void> {
      if (response.status >= 500) return this.abandon(claimId);
      if (response.status < 100 || response.status > 499) {
         throw new Error('idempotency response status is invalid');
      }
      if (Buffer.byteLength(response.body, 'utf8') > MAX_REPLAY_BODY) {
         throw new Error(`idempotency response exceeds ${MAX_REPLAY_BODY} bytes`);
      }

      const now = this.clock();
      const updated = await this.sql`
         UPDATE idempotency_records
            SET response_status = ${response.status},
                response_headers = ${this.sql.json(replayHeaders(response.headers))}::jsonb,
                response_body = ${Buffer.from(response.body, 'utf8')},
                completed_at = ${now.toISOString()},
                lease_expires_at = ${now.toISOString()},
                expires_at = ${new Date(now.getTime() + TTL_MS).toISOString()}
          WHERE id = ${claimId} AND response_status IS NULL`;
      if (updated.count !== 1) throw new Error('idempotency claim is not open');
   }

   /** Releases an uncompleted claim so the key can be used again immediately. */
   async abandon(claimId: string): Promise<void> {
      await this.sql`
         DELETE FROM idempotency_records WHERE id = ${claimId} AND response_status IS NULL`;
   }
}
