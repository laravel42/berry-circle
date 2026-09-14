import { ApiError } from '../http/errors.ts';

/**
 * Identity domain failures.
 *
 * Each carries the status, code and wording Go sends, because the frontend
 * switches on `code` and shows `message`.
 */

export class NotFound extends Error {
   constructor() {
      super('not found');
      this.name = 'NotFound';
   }
}

export class Forbidden extends Error {
   constructor() {
      super('forbidden');
      this.name = 'Forbidden';
   }
}

/** A workspace must retain at least one owner. */
export class LastOwner extends Error {
   constructor() {
      super('last owner');
      this.name = 'LastOwner';
   }
}

/** Every invalid invitation state, deliberately indistinguishable. */
export class InvitationInvalid extends Error {
   constructor() {
      super('invitation invalid');
      this.name = 'InvitationInvalid';
   }
}

export class Conflict extends Error {
   constructor() {
      super('conflict');
      this.name = 'Conflict';
   }
}

/**
 * A server misconfiguration surfaced at request time — e.g. a session TTL
 * outside the accepted bounds. It is not an {@link ApiError}, so it falls
 * through to the shell's `app.onError` and answers 500 `INTERNAL` rather than
 * describing the misconfiguration to the caller.
 */
export class ConfigError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'ConfigError';
   }
}

/** The same Idempotency-Key arrived with a different body. */
export class IdempotencyConflict extends Error {
   constructor() {
      super('idempotency conflict');
      this.name = 'IdempotencyConflict';
   }
}

/**
 * Maps a domain failure onto the wire.
 *
 * `resource` names what was being acted on, because Go's message is built from
 * it — "Workspace not found." and "Member not found." come from the same code
 * path and a caller can tell them apart.
 */
export function toApiError(error: unknown, resource: string): unknown {
   if (error instanceof NotFound) return ApiError.notFound(resource);
   if (error instanceof Forbidden) {
      return new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   if (error instanceof InvitationInvalid) {
      return new ApiError(404, 'INVITATION_INVALID', 'Invitation not found or no longer valid.');
   }
   if (error instanceof LastOwner) {
      return new ApiError(409, 'LAST_OWNER_REQUIRED', 'A workspace must retain at least one owner.');
   }
   if (error instanceof IdempotencyConflict) {
      return new ApiError(
         409,
         'IDEMPOTENCY_CONFLICT',
         'The Idempotency-Key was already used with different input.'
      );
   }
   if (error instanceof Conflict) {
      return new ApiError(409, 'CONFLICT', `${resource} conflicts with an existing resource.`);
   }
   return error;
}

/** Runs `work`, translating identity failures into the response Go sends. */
export async function domain<T>(resource: string, work: () => Promise<T>): Promise<T> {
   try {
      return await work();
   } catch (error) {
      throw toApiError(error, resource);
   }
}
