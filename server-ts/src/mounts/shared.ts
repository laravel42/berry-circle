import { createHash } from 'node:crypto';
import { ApiError } from '../http/errors.ts';
import { assertValid, fieldError } from '../http/body.ts';
import type { Membership } from '../identity/workspaces.ts';

/** Helpers shared by the identity mounts, ported from validation.go. */

/**
 * A malformed id is 404, not 400.
 *
 * Go parses the path segment and answers "not found" when it is not a
 * canonical UUID, which is also the answer for an id that simply is not
 * there — so a caller cannot probe which ids exist by their shape.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function pathId(raw: string | undefined, resource: string): string {
   if (!raw || !UUID.test(raw) || raw.toLowerCase() === NIL_UUID) {
      throw ApiError.notFound(resource);
   }
   return raw.toLowerCase();
}

export function requireIdempotencyKey(headers: Headers): string {
   // Headers.get joins repeats with ", ", so counting entries is the only way
   // to tell one key from two that happen to concatenate into a valid one.
   const values = [...headers].filter(([name]) => name.toLowerCase() === 'idempotency-key');
   const key = values.length === 1 ? (values[0]?.[1] ?? '') : '';
   if (key.length < 16 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      assertValid([
         fieldError(
            '/headers/Idempotency-Key',
            'invalid',
            'Idempotency-Key must be one visible ASCII value from 16 to 128 characters.'
         ),
      ]);
   }
   return key;
}

/**
 * Fingerprints the body so a replayed key with different content is caught.
 *
 * Taken over a re-serialisation of the parsed value rather than the raw bytes,
 * so whitespace and key order do not make the same request look different —
 * which is what Go's json.Marshal of the decoded value achieves.
 */
export function fingerprintJSON(raw: string): Buffer {
   return createHash('sha256').update(JSON.stringify(JSON.parse(raw))).digest();
}

export async function requireEmptyBody(request: Request): Promise<void> {
   const body = await request.text();
   if (body.trim() !== '') {
      assertValid([
         fieldError('/', 'unrecognized_body', 'This operation does not accept a request body.'),
      ]);
   }
}

export function serializeMember(member: Membership): Record<string, unknown> {
   return {
      userId: member.userId,
      workspaceId: member.workspaceId,
      role: member.role,
      email: member.email,
      name: member.name,
      avatarUrl: member.avatarUrl,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
   };
}
