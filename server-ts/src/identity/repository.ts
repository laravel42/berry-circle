import { toRFC3339, type Sql } from '../db/pool.ts';

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
}
