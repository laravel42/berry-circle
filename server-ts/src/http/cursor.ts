import { ApiError } from './errors.ts';

/**
 * Opaque pagination cursors.
 *
 * The envelope is versioned and scoped so a cursor cannot be replayed against
 * a different collection: a token minted for one user's workspaces decodes to
 * nothing anywhere else. Scope is checked before the key is read.
 *
 * The encoding is fixed byte for byte. Clients hold cursors across restarts
 * and deployments, so a change to the field order or the timestamp format
 * would invalidate every token already in a browser's hands.
 */

const SCOPE = /^[a-z][a-z0-9._-]{0,99}$/;
const MAX_TOKEN = 4096;
const MAX_BODY = 3072;

export class InvalidCursor extends ApiError {
   constructor() {
      super(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
   }
}

/** `{createdAt, id}` — the stable descending key for time-ordered collections. */
export interface TimeCursor {
   createdAt: string;
   id: string;
}

/** `{updatedAt, id}` — issues page by recency of change, not of creation. */
export interface UpdatedCursor {
   updatedAt: string;
   id: string;
}

/**
 * `{sortOrder, id}` — resources page by the order their owner chose.
 *
 * `sortOrder` is a number on the wire, because Go's field is an int. Encoding
 * it as a string would produce different bytes and a cursor neither server
 * could read from the other.
 */
export interface SortOrderCursor {
   sortOrder: number;
   id: string;
}

/** `{name, id}` — the stable ascending key for member collections. */
export interface NameCursor {
   name: string;
   id: string;
}

export function encodeCursor(
   scope: string,
   key: TimeCursor | NameCursor | UpdatedCursor | SortOrderCursor
): string | null {
   if (!SCOPE.test(scope)) return null;
   // Key order is Go's struct order, and it is load-bearing: the token is the
   // base64 of these exact bytes.
   const body = JSON.stringify({ v: 1, scope, key });
   return Buffer.from(body, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor for one expected scope, or throws.
 *
 * Every failure is the same error, deliberately: a caller cannot learn whether
 * a token was malformed, expired in shape, or minted for someone else's list.
 */
export function decodeCursor<T extends TimeCursor | NameCursor | UpdatedCursor | SortOrderCursor>(
   token: string,
   expectedScope: string,
   required: readonly string[]
): T {
   if (token === '' || token.length > MAX_TOKEN || !SCOPE.test(expectedScope)) {
      throw new InvalidCursor();
   }
   const body = Buffer.from(token, 'base64url');
   // Round-trip check: Buffer.from ignores characters outside the alphabet, so
   // without it `!!!` would decode to empty rather than being refused.
   if (body.toString('base64url') !== token || body.length > MAX_BODY) {
      throw new InvalidCursor();
   }

   let envelope: unknown;
   try {
      envelope = JSON.parse(body.toString('utf8'));
   } catch {
      throw new InvalidCursor();
   }
   if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new InvalidCursor();
   }
   const { v, scope, key, ...rest } = envelope as Record<string, unknown>;
   // DisallowUnknownFields, on the envelope and on the key alike.
   if (Object.keys(rest).length > 0 || v !== 1 || scope !== expectedScope) {
      throw new InvalidCursor();
   }
   if (key === null || typeof key !== 'object' || Array.isArray(key)) {
      throw new InvalidCursor();
   }

   const fields = key as Record<string, unknown>;
   if (Object.keys(fields).some((name) => !required.includes(name))) {
      throw new InvalidCursor();
   }
   // Go rejects a zero uuid and a zero time, so a key present but empty is
   // refused rather than paging from the beginning. A numeric key is allowed
   // because some cursors carry an integer position rather than a timestamp.
   for (const name of required) {
      const value = fields[name];
      const usable =
         (typeof value === 'string' && value !== '') ||
         (typeof value === 'number' && Number.isFinite(value));
      if (!usable) throw new InvalidCursor();
   }
   return fields as T;
}

/** The two key shapes, named so call sites cannot pass the wrong field list. */
export const TIME_CURSOR_KEYS = ['createdAt', 'id'] as const;
export const NAME_CURSOR_KEYS = ['name', 'id'] as const;
export const UPDATED_CURSOR_KEYS = ['updatedAt', 'id'] as const;
export const SORT_ORDER_CURSOR_KEYS = ['sortOrder', 'id'] as const;

export function decodeTimeCursor(token: string, scope: string): TimeCursor {
   return decodeCursor<TimeCursor>(token, scope, TIME_CURSOR_KEYS);
}

export function decodeNameCursor(token: string, scope: string): NameCursor {
   return decodeCursor<NameCursor>(token, scope, NAME_CURSOR_KEYS);
}

/** Query parsing for `?first=&after=`, ported from validation.go. */
export interface Page {
   first: number;
   after: string;
}

export function parsePageQuery(url: URL, allowed: readonly string[] = []): Page {
   const seen = new Set<string>();
   for (const name of url.searchParams.keys()) {
      if (name !== 'first' && name !== 'after' && !allowed.includes(name)) {
         throw validationError(`/query/${name}`, 'unknown', 'Unknown query parameter.');
      }
      if (seen.has(name)) {
         throw validationError(`/query/${name}`, 'duplicate', 'Query parameter must appear once.');
      }
      seen.add(name);
   }

   let first = 50;
   const raw = url.searchParams.get('first');
   if (raw !== null && raw !== '') {
      // Go's strconv.Atoi accepts only an optionally signed decimal integer:
      // Number() would take "1e2", " 5" and "0x10".
      const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
         throw validationError(
            '/query/first',
            'out_of_range',
            'first must be an integer from 1 to 100.'
         );
      }
      first = parsed;
   }
   return { first, after: url.searchParams.get('after') ?? '' };
}

function validationError(path: string, code: string, message: string): ApiError {
   return new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
      fields: [{ path, code, message }],
   });
}
