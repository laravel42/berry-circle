import { randomUUID } from 'node:crypto';

/**
 * The correlation identifier, in the shape the Go server emits:
 * `req_` followed by a UUID with its hyphens removed
 * (server/internal/httpapi/router.go). It travels back as `X-Request-Id` and
 * inside every error envelope, and `frontend/lib/api.ts` reads both.
 */
export function newRequestId(): string {
   return 'req_' + randomUUID().replaceAll('-', '');
}

/** Whether a client-supplied request id is safe to echo rather than replace. */
export function isValidRequestId(value: string | undefined | null): value is string {
   return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
