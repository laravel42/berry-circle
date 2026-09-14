import { randomBytes } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { digestToken, generatePersonalToken } from './tokens.ts';

/**
 * A real personal access token for a database test, inserted directly.
 *
 * Tests that only need *a* signed-in caller use this rather than a browser
 * session: a PAT goes through the production bearer path, needs no Better
 * Auth instance, and is as real a credential as the cookie. Not imported by
 * production code.
 */
export async function issueTestToken(sql: Sql, userId: string): Promise<string> {
   const issued = generatePersonalToken();
   await sql`
      INSERT INTO personal_api_tokens (
         user_id, name, public_id, secret_hash, idempotency_key_hash, request_fingerprint
      ) VALUES (
         ${userId}, 'test', ${issued.publicId}, ${issued.secretHash},
         ${digestToken(randomBytes(16).toString('hex'))},
         ${digestToken(randomBytes(16).toString('hex'))}
      )`;
   return issued.token;
}
