import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import type { FieldError } from '../http/errors.ts';
import {
   ONBOARDING_ANSWER_KEYS,
   ONBOARDING_STEPS,
   THEMES,
   boundedLength,
   validAvatar,
   validTimezone,
} from '../http/validation.ts';
import {
   NotFound,
   type IdentityRepository,
   type OnboardingState,
   type Profile,
   type UserSettings,
   type Workspace,
} from '../identity/repository.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/me`.
 *
 * `bootstrap` is the first authenticated call the app makes — everything the
 * shell needs to render before it knows what page it is on — so it is the
 * mount worth having right early.
 */

export interface MeOptions {
   sessions: SessionService;
   identity: IdentityRepository;
}

export function meMounts(options: MeOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { identity } = options;

   route.get('/', async (context) =>
      json(serializeProfile(await profileOf(identity, context.get('user').id)))
   );

   route.patch('/', async (context) => {
      const userId = context.get('user').id;
      // avatarUrl is 'raw' because clearing it and omitting it are different
      // requests, and only the raw value distinguishes them.
      const { value } = await decodeBody<ProfilePatchBody>(context, {
         name: 'string',
         avatarUrl: 'raw',
      });
      const fields: FieldError[] = [];

      // Seeded from the body, as Go's `ProfilePatch{Name: body.Name}` is: the
      // empty-patch check below asks whether a field was *provided*, not
      // whether it was valid, so an invalid name must not also read as absent.
      // The untrimmed value never reaches the database — validation throws first.
      const patch: { name: string | undefined; avatarUrlSet: boolean; avatarUrl?: string | null } = {
         name: value.name,
         avatarUrlSet: false,
      };
      if (value.name !== undefined) {
         const trimmed = value.name.trim();
         if (!boundedLength(trimmed, 1, 100)) {
            fields.push(
               fieldError('/name', 'invalid_length', 'Name must contain 1 to 100 characters.')
            );
         } else {
            patch.name = trimmed;
         }
      }
      // Present-and-null clears the avatar; absent leaves it. `in` is the only
      // check that separates them, which is why the raw object is consulted
      // rather than the destructured value.
      if ('avatarUrl' in value) {
         patch.avatarUrlSet = true;
         if (value.avatarUrl !== null) {
            if (typeof value.avatarUrl !== 'string' || !validAvatar(value.avatarUrl)) {
               fields.push(
                  fieldError(
                     '/avatarUrl',
                     'invalid_url',
                     'Avatar URL must be null or an absolute HTTP(S) URL.'
                  )
               );
            } else {
               patch.avatarUrl = value.avatarUrl;
            }
         }
      }
      if (patch.name === undefined && !patch.avatarUrlSet) {
         fields.push(fieldError('/', 'empty_patch', 'At least one profile field is required.'));
      }
      assertValid(fields);

      return json(serializeProfile(await notFoundAsUser(() => identity.updateProfile(userId, patch))));
   });

   route.get('/bootstrap', async (context) => {
      const result = await notFoundAsUser(() => identity.bootstrap(context.get('user').id));
      return json({
         user: serializeProfile(result.profile),
         workspaces: result.workspaces.map(serializeWorkspace),
         currentWorkspaceId: result.currentWorkspaceId,
      });
   });

   route.get('/settings', async (context) =>
      json(serializeSettings((await profileOf(identity, context.get('user').id)).settings))
   );

   route.patch('/settings', async (context) => {
      const userId = context.get('user').id;
      const { value } = await decodeBody<UserSettingsPatchBody>(context, {
         theme: 'string',
         timezone: 'string',
         reducedMotion: 'boolean',
      });
      const fields: FieldError[] = [];

      if (value.theme !== undefined && !THEMES.includes(value.theme as (typeof THEMES)[number])) {
         fields.push(
            fieldError('/theme', 'invalid_enum_value', 'Theme must be system, light, or dark.')
         );
      }
      if (value.timezone !== undefined && !validTimezone(value.timezone)) {
         fields.push(
            fieldError('/timezone', 'invalid_timezone', 'Timezone must be a valid IANA timezone.')
         );
      }
      if (value.theme === undefined && value.timezone === undefined && value.reducedMotion === undefined) {
         fields.push(fieldError('/', 'empty_patch', 'At least one setting is required.'));
      }
      assertValid(fields);

      // Read, merge, write: Go patches onto the stored value rather than
      // replacing it, so an absent field keeps what is already there.
      const current = await profileOf(identity, userId);
      const next: UserSettings = {
         theme: value.theme ?? current.settings.theme,
         timezone: value.timezone ?? current.settings.timezone,
         reducedMotion: value.reducedMotion ?? current.settings.reducedMotion,
      };
      return json(serializeSettings(await notFoundAsUser(() => identity.updateUserSettings(userId, next))));
   });

   route.get('/onboarding', async (context) =>
      json(serializeOnboarding((await profileOf(identity, context.get('user').id)).onboarding))
   );

   route.patch('/onboarding', async (context) => {
      const userId = context.get('user').id;
      const { value } = await decodeBody<OnboardingPatchBody>(context, {
         step: 'string',
         answers: 'stringMap',
         skipped: 'boolean',
         completed: 'boolean',
      });
      if (
         value.step === undefined &&
         value.answers === undefined &&
         value.skipped === undefined &&
         value.completed === undefined
      ) {
         assertValid([
            fieldError('/', 'empty_patch', 'At least one onboarding field is required.'),
         ]);
      }

      const current = await profileOf(identity, userId);
      const next: OnboardingState = { ...current.onboarding, version: 1 };
      next.answers ??= {};
      const fields: FieldError[] = [];

      if (value.step !== undefined) {
         if (ONBOARDING_STEPS.includes(value.step as (typeof ONBOARDING_STEPS)[number])) {
            next.step = value.step;
         } else {
            fields.push(
               fieldError(
                  '/step',
                  'invalid_enum_value',
                  'Step must be welcome, aboutYou, workspace, or complete.'
               )
            );
         }
      }
      if (value.answers !== undefined) {
         const entries = Object.entries(value.answers ?? {});
         if (entries.length > 10) {
            fields.push(
               fieldError('/answers', 'too_many', 'At most 10 onboarding answers are accepted.')
            );
         } else {
            // Replaced wholesale, not merged: Go rebuilds the map, so omitting
            // an answer removes it.
            next.answers = {};
            for (const [key, answer] of entries) {
               const trimmed = answer.trim();
               if (
                  !ONBOARDING_ANSWER_KEYS.includes(key as (typeof ONBOARDING_ANSWER_KEYS)[number]) ||
                  !boundedLength(trimmed, 1, 500)
               ) {
                  fields.push(
                     fieldError(`/answers/${key}`, 'invalid', 'Answer key or value is not supported.')
                  );
                  continue;
               }
               next.answers[key] = trimmed;
            }
         }
      }
      if (value.skipped !== undefined) next.skipped = value.skipped;
      if (value.completed !== undefined) next.completed = value.completed;

      // Skipping is a way of completing, and completing means the last step.
      if (next.skipped) next.completed = true;
      if (next.completed) next.step = 'complete';

      assertValid(fields);

      const { state } = await notFoundAsUser(() => identity.updateOnboarding(userId, next));
      return json(serializeOnboarding(state));
   });

   return [{ prefix: '/api/v1/me', handler: route }];
}

interface ProfilePatchBody {
   name?: string;
   avatarUrl?: string | null;
}

interface UserSettingsPatchBody {
   theme?: string;
   timezone?: string;
   reducedMotion?: boolean;
}

interface OnboardingPatchBody {
   step?: string;
   answers?: Record<string, string>;
   skipped?: boolean;
   completed?: boolean;
}

async function profileOf(identity: IdentityRepository, userId: string): Promise<Profile> {
   const { profile } = await notFoundAsUser(() => identity.getProfile(userId));
   return profile;
}

/** Go answers `User not found.` for every missing row in this mount. */
async function notFoundAsUser<T>(run: () => Promise<T>): Promise<T> {
   try {
      return await run();
   } catch (error) {
      if (error instanceof NotFound) throw ApiError.notFound('User');
      throw error;
   }
}

/** Field order follows Go's struct declaration, which is what goes on the wire. */
function serializeProfile(profile: Profile): Record<string, unknown> {
   return {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      settings: serializeSettings(profile.settings),
      onboarding: serializeOnboarding(profile.onboarding),
      onboardedAt: profile.onboardedAt,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
   };
}

function serializeSettings(settings: UserSettings): Record<string, unknown> {
   return {
      theme: settings.theme,
      timezone: settings.timezone,
      reducedMotion: settings.reducedMotion,
   };
}

function serializeOnboarding(state: OnboardingState): Record<string, unknown> {
   return {
      version: state.version,
      step: state.step,
      answers: state.answers,
      skipped: state.skipped,
      completed: state.completed,
   };
}

export function serializeWorkspace(workspace: Workspace): Record<string, unknown> {
   return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      // Declaration order, matching Go's WorkspaceSettings struct.
      settings: {
         issuePrefix: workspace.settings.issuePrefix,
         defaultRole: workspace.settings.defaultRole,
         allowMemberInvites: workspace.settings.allowMemberInvites,
      },
      role: workspace.role,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
   };
}
