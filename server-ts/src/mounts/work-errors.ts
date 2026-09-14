import { ApiError } from '../http/errors.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { InvalidTransition } from '../core/issues.ts';
import {
   InvalidPropertyValue,
   MAX_ACTIVE_PROPERTIES,
   PropertyKindMismatch,
   PropertyNameTaken,
   TooManyProperties,
} from '../work/properties.ts';
import { MetadataTooLarge } from '../work/metadata.ts';
import { HierarchyCycle, ParentNotFound } from '../work/hierarchy.ts';
import { NotAThreadRoot } from '../work/comment-resolution.ts';
import { StatusNameTaken, StatusOrderMismatch, SystemStatusProtected } from '../work/statuses.ts';
import { ViewRevisionConflict } from '../work/views.ts';
import { QuickActionNameTaken, QuickActionNotArchived } from '../work/quick-actions.ts';
import { JoinLinkInvalid } from '../work/join-links.ts';

/** Work-tracking domain failures in the API's words, mapped once. */
export function rethrowWork(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof ApiError) throw error;
      if (error instanceof InvalidPropertyValue) {
         throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
            fields: error.issues.map((issue) => ({ path: issue.path, code: 'invalid_value', message: issue.message })),
         });
      }
      if (error instanceof PropertyKindMismatch) {
         throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
            fields: [{ path: '/options', code: 'invalid_value', message: 'Only a select has options.' }],
         });
      }
      if (error instanceof TooManyProperties) {
         throw new ApiError(
            409,
            'CONFLICT',
            `A workspace has at most ${MAX_ACTIVE_PROPERTIES} active properties. Archive one first.`
         );
      }
      if (error instanceof MetadataTooLarge) {
         throw new ApiError(422, 'METADATA_TOO_LARGE', 'Metadata holds at most 50 keys and 16 KB.');
      }
      if (
         error instanceof PropertyNameTaken ||
         error instanceof StatusNameTaken ||
         error instanceof QuickActionNameTaken
      ) {
         throw new ApiError(409, 'CONFLICT', 'That name is already taken.');
      }
      if (error instanceof HierarchyCycle) {
         throw new ApiError(409, 'HIERARCHY_CYCLE', 'An issue cannot be nested under its own sub-issue.');
      }
      if (error instanceof ParentNotFound) {
         throw new ApiError(422, 'PARENT_NOT_FOUND', 'That parent issue does not exist in this workspace.');
      }
      if (error instanceof NotAThreadRoot) {
         throw new ApiError(422, 'NOT_A_THREAD_ROOT', 'Only the first comment of a thread can be resolved.');
      }
      if (error instanceof SystemStatusProtected) {
         throw new ApiError(409, 'STATUS_PROTECTED', 'A built-in status cannot be archived.');
      }
      if (error instanceof QuickActionNotArchived) {
         throw new ApiError(409, 'CONFLICT', 'Archive a quick action before deleting it.');
      }
      if (error instanceof StatusOrderMismatch) {
         throw new ApiError(422, 'STATUS_ORDER_MISMATCH', 'The order must list every active status once.');
      }
      if (error instanceof ViewRevisionConflict) {
         throw new ApiError(409, 'REVISION_CONFLICT', 'The view changed since it was last read.', {
            currentRevision: error.currentRevision,
         });
      }
      if (error instanceof JoinLinkInvalid) {
         throw new ApiError(404, 'NOT_FOUND', 'This join link is not valid.');
      }
      if (error instanceof InvalidTransition) {
         throw new ApiError(409, 'INVALID_STATE_TRANSITION', `Cannot transition an issue from "${error.from}" to "${error.to}".`, {
            from: error.from,
            to: error.to,
         });
      }
      if (error instanceof Conflict) throw new ApiError(409, 'CONFLICT', 'The change conflicts with the current state.');
      if (error instanceof NotFound) throw ApiError.notFound(resource);
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}
