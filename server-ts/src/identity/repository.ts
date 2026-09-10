import { createHash } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, IdempotencyConflict } from './errors.ts';

/**
 * Identity reads.
 *
 * Workspace membership is the security boundary for everything above it: a
 * workspace a user is not a member of does not appear here, so a handler
 * cannot leak one by forgetting a check. Every query joins
 * `workspace_memberships` for that reason rather than for convenience.
 */

export type UserSettings = {
   theme: string;
   timezone: string;
   reducedMotion: boolean;
   /** Interface language; one of `LOCALES` in http/validation.ts. */
   locale: string;
}

export type OnboardingState = {
   version: number;
   step: string;
   answers: Record<string, string>;
   skipped: boolean;
   completed: boolean;
}

export interface Profile {
   id: string;
   email: string;
   name: string;
   avatarUrl: string | null;
   settings: UserSettings;
   onboarding: OnboardingState;
   onboardedAt: string | null;
   createdAt: string;
   updatedAt: string;
}

/**
 * The bounded workspace settings Go declares as a struct.
 *
 * Typed rather than passed through as raw JSONB, because PostgreSQL
 * normalises jsonb key order and Go emits the struct's declaration order —
 * `issuePrefix` first. Passing the column through changes the bytes on the
 * wire even when every value matches.
 */
export type WorkspaceSettings = {
   issuePrefix: string;
   defaultRole: string;
   allowMemberInvites: boolean;
}

export interface Workspace {
   id: string;
   name: string;
   slug: string;
   description: string | null;
   settings: WorkspaceSettings;
   role: string;
   createdAt: string;
   updatedAt: string;
}

export interface Bootstrap {
   profile: Profile;
   workspaces: Workspace[];
   currentWorkspaceId: string | null;
}

export class NotFound extends Error {
   constructor() {
      super('not found');
      this.name = 'NotFound';
   }
}

/**
 * Defaults for a user whose JSON columns were written before a field existed.
 *
 * Go decodes into a struct, so an absent key becomes the zero value and the
 * response always carries every field. Reading raw JSON here would let a
 * partial object reach the browser, so the shape is filled in explicitly.
 */
function toSettings(value: unknown): UserSettings {
   const raw = (value ?? {}) as Partial<UserSettings>;
   return {
      theme: raw.theme ?? 'system',
      timezone: raw.timezone ?? 'UTC',
      reducedMotion: raw.reducedMotion ?? false,
      // Rows written before the preference existed have no key; they read as
      // the default rather than as a partial object.
      locale: typeof raw.locale === 'string' ? raw.locale : 'en',
   };
}

function toWorkspaceSettings(value: unknown): WorkspaceSettings {
   const raw = (value ?? {}) as Partial<WorkspaceSettings>;
   return {
      issuePrefix: raw.issuePrefix ?? '',
      defaultRole: raw.defaultRole ?? '',
      allowMemberInvites: raw.allowMemberInvites ?? false,
   };
}

function toOnboarding(value: unknown): OnboardingState {
   const raw = (value ?? {}) as Partial<OnboardingState>;
   return {
      version: raw.version ?? 0,
      step: raw.step ?? '',
      answers: raw.answers ?? {},
      skipped: raw.skipped ?? false,
      completed: raw.completed ?? false,
   };
}

function toProfile(row: Record<string, unknown>): Profile {
   return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      settings: toSettings(row.settings),
      onboarding: toOnboarding(row.onboarding_state),
      onboardedAt: row.onboarding_completed_at
         ? toRFC3339(row.onboarding_completed_at as string)
         : null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/** A sparse patch: `avatarUrlSet` distinguishes "clear it" from "leave it". */
export interface ProfilePatch {
   name: string | undefined;
   avatarUrlSet: boolean;
   avatarUrl?: string | null;
}

export class IdentityRepository {
   private readonly sql: Sql;
   private readonly clock: () => Date;

   // Written out rather than a parameter property: Node strips types without
   // compiling, and a parameter property emits an assignment, so it is not
   // erasable syntax. `erasableSyntaxOnly` in tsconfig makes that a typecheck
   // error instead of something discovered when the server will not boot.
   constructor(sql: Sql, clock: () => Date = () => new Date()) {
      this.sql = sql;
      this.clock = clock;
   }

   /**
    * The clock is injected so tests can pin timestamps.
    *
    * Note that `updated_at` is not actually settable: a
    * `berry_users_set_updated_at` trigger overwrites it on every UPDATE. The
    * parameter is kept so the write states the time it means, rather than
    * leaving a reader to discover the trigger before they can tell what sets
    * it.
    */
   private now(): string {
      return this.clock().toISOString();
   }

   async getProfile(userId: string): Promise<{ profile: Profile; currentWorkspaceId: string | null }> {
      const [row] = await this.sql`
         SELECT id, email, name, avatar_url, settings, onboarding_state,
                onboarding_completed_at, last_workspace_id, created_at, updated_at
           FROM users
          WHERE id = ${userId}`;
      if (!row) throw new NotFound();
      return {
         profile: toProfile(row),
         currentWorkspaceId: (row.last_workspace_id as string | null) ?? null,
      };
   }

   /** Only workspaces the user belongs to, and only ones not deleted. */
   async listWorkspaces(userId: string, limit = 100): Promise<Workspace[]> {
      const rows = await this.sql`
         SELECT w.id, w.name, w.slug, w.description, w.settings,
                m.role::text AS role, w.created_at, w.updated_at
           FROM workspace_memberships AS m
           JOIN workspaces AS w ON w.id = m.workspace_id
          WHERE m.user_id = ${userId}
            AND w.deleted_at IS NULL
          ORDER BY w.created_at DESC, w.id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         name: row.name as string,
         slug: row.slug as string,
         description: (row.description as string | null) ?? null,
         settings: toWorkspaceSettings(row.settings),
         role: row.role as string,
         createdAt: toRFC3339(row.created_at as string) ?? '',
         updatedAt: toRFC3339(row.updated_at as string) ?? '',
      }));
   }

   /**
    * Everything the app needs on load.
    *
    * The remembered workspace is verified against membership rather than
    * trusted: a user removed from the workspace they last visited would
    * otherwise boot straight into one they can no longer read.
    */
   async bootstrap(userId: string): Promise<Bootstrap> {
      const { profile, currentWorkspaceId } = await this.getProfile(userId);
      const workspaces = await this.listWorkspaces(userId);
      const current =
         currentWorkspaceId && workspaces.some((workspace) => workspace.id === currentWorkspaceId)
            ? currentWorkspaceId
            : null;
      return { profile, workspaces, currentWorkspaceId: current };
   }

   /**
    * Applies a sparse profile patch.
    *
    * The CASE-per-column form is Go's, and it is the reason `avatarUrl: null`
    * clears the avatar while an absent `avatarUrl` leaves it alone: the flag
    * says whether the caller mentioned the field, and the value says what to
    * set. Collapsing that to COALESCE would make the two indistinguishable.
    */
   async updateProfile(userId: string, patch: ProfilePatch): Promise<Profile> {
      const [row] = await this.sql`
         UPDATE users
            SET name = CASE WHEN ${patch.name !== undefined} THEN ${patch.name ?? null}::text ELSE name END,
                avatar_url = CASE WHEN ${patch.avatarUrlSet} THEN ${patch.avatarUrl ?? null}::text ELSE avatar_url END,
                updated_at = ${this.now()}
          WHERE id = ${userId}
          RETURNING id, email, name, avatar_url, settings, onboarding_state,
                    onboarding_completed_at, last_workspace_id, created_at, updated_at`;
      if (!row) throw new NotFound();
      return toProfile(row);
   }

   /** Replaces a complete, already-validated settings value. */
   async updateUserSettings(userId: string, settings: UserSettings): Promise<UserSettings> {
      const [row] = await this.sql`
         UPDATE users
            SET settings = ${this.sql.json(settings)}::jsonb, updated_at = ${this.now()}
          WHERE id = ${userId}
          RETURNING settings`;
      if (!row) throw new NotFound();
      return toSettings(row.settings);
   }

   /**
    * Persists one complete onboarding state.
    *
    * `COALESCE(onboarding_completed_at, $4)` keeps the first completion time
    * rather than restamping it, so a user who revisits a finished onboarding
    * does not appear to have onboarded today.
    */
   async updateOnboarding(
      userId: string,
      state: OnboardingState
   ): Promise<{ state: OnboardingState; completedAt: string | null }> {
      const [row] = await this.sql`
         UPDATE users
            SET onboarding_state = ${this.sql.json(state)}::jsonb,
                onboarding_completed_at = CASE
                    WHEN ${state.completed} THEN COALESCE(onboarding_completed_at, ${this.now()})
                    ELSE NULL
                END,
                updated_at = ${this.now()}
          WHERE id = ${userId}
          RETURNING onboarding_state, onboarding_completed_at`;
      if (!row) throw new NotFound();
      return {
         state: toOnboarding(row.onboarding_state),
         completedAt: row.onboarding_completed_at
            ? toRFC3339(row.onboarding_completed_at as string)
            : null,
      };
   }

   /**
    * Creates a password-credentialed user, or replays the account a prior
    * request with the same Idempotency-Key already created.
    *
    * Idempotency is the same mechanism as `WorkspaceRepository.create`: the
    * key hash and the request-body fingerprint are stored on the created row,
    * a partial unique index on `creation_key_hash` turns a replay into an
    * `ON CONFLICT DO NOTHING`, and the conflicting path compares the stored
    * fingerprint. Replaying the same key with the same body returns the same
    * user; replaying it with a different body is an `IdempotencyConflict`
    * rather than a silent second account. A duplicate email — the same address
    * with no key, or a different key — is the unique-index violation on
    * `lower(email)` mapped to `Conflict` (→ 409), and creates no user.
    *
    * Runs on the passed `executor` rather than opening its own transaction so
    * the caller can create the user and issue its session in one `sql.begin`:
    * a failure on either side leaves neither a user nor a session behind.
    */
   async createUserWithPassword(
      executor: Queryable,
      params: {
         email: string;
         name: string;
         passwordHash: Buffer;
         passwordSalt: Buffer;
         idempotencyKey: string | null;
         fingerprint: Buffer | null;
      }
   ): Promise<{ userId: string; replayed: boolean }> {
      const id = crypto.randomUUID();
      const now = this.now();
      const keyHash =
         params.idempotencyKey === null
            ? null
            : createHash('sha256').update(params.idempotencyKey).digest();

      // No key: a plain insert, so two keyless sign-ups of the same address
      // both reach the email unique index and the second is a Conflict, never
      // an accidental replay of an unrelated request.
      if (keyHash === null) {
         const [row] = await executor`
            INSERT INTO users (id, email, name, password_hash, password_salt,
                               password_updated_at, created_at, updated_at)
            VALUES (${id}, ${params.email}, ${params.name}, ${params.passwordHash},
                    ${params.passwordSalt}, ${now}, ${now}, ${now})
            RETURNING id`.catch(classifyUserWrite);
         if (!row) throw new Conflict();
         return { userId: row.id as string, replayed: false };
      }

      const inserted = await executor`
         INSERT INTO users (id, email, name, password_hash, password_salt,
                            password_updated_at, creation_key_hash, creation_fingerprint,
                            created_at, updated_at)
         VALUES (${id}, ${params.email}, ${params.name}, ${params.passwordHash},
                 ${params.passwordSalt}, ${now}, ${keyHash}, ${params.fingerprint},
                 ${now}, ${now})
         ON CONFLICT (creation_key_hash) WHERE creation_key_hash IS NOT NULL
         DO NOTHING
         RETURNING id`.catch(classifyUserWrite);

      if (inserted.length > 0) {
         return { userId: inserted[0]!.id as string, replayed: false };
      }

      // The key is already spoken for: replay if the body matches, conflict if
      // it does not.
      const [existing] = await executor`
         SELECT id, creation_fingerprint
           FROM users
          WHERE creation_key_hash = ${keyHash}`;
      if (!existing) throw new NotFound();
      if (
         params.fingerprint === null ||
         !timingSafeEqualBytes(existing.creation_fingerprint as Buffer | null, params.fingerprint)
      ) {
         throw new IdempotencyConflict();
      }
      return { userId: existing.id as string, replayed: true };
   }
}

/**
 * A unique-violation on sign-up is a taken email, not a server error.
 *
 * 23505 is `users_email_ci_key` (case-insensitive email) or the sign-up
 * idempotency index; either way the caller asked for something that already
 * exists, so it is a 409, not a 500. Anything else keeps its original error.
 */
function classifyUserWrite(error: unknown): never {
   if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      throw new Conflict();
   }
   throw error;
}

/** Constant-time comparison; a length difference is reported without leaking where. */
function timingSafeEqualBytes(left: Buffer | null, right: Buffer): boolean {
   if (!left || left.length !== right.length) return false;
   let difference = 0;
   for (let index = 0; index < left.length; index += 1) {
      difference |= left[index]! ^ right[index]!;
   }
   return difference === 0;
}
