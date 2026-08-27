import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { NotFound, type IdentityRepository, type Profile, type Workspace } from '../identity/repository.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/me`, ported from server/internal/handlers/identity.
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

   route.get('/bootstrap', async (context) => {
      const user = context.get('user');
      try {
         const result = await options.identity.bootstrap(user.id);
         return json({
            user: serializeProfile(result.profile),
            workspaces: result.workspaces.map(serializeWorkspace),
            currentWorkspaceId: result.currentWorkspaceId,
         });
      } catch (error) {
         if (error instanceof NotFound) throw ApiError.notFound('User');
         throw error;
      }
   });

   return [{ prefix: '/api/v1/me', handler: route }];
}

/** Field order follows Go's struct declaration, which is what goes on the wire. */
function serializeProfile(profile: Profile): Record<string, unknown> {
   return {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      settings: {
         theme: profile.settings.theme,
         timezone: profile.settings.timezone,
         reducedMotion: profile.settings.reducedMotion,
      },
      onboarding: {
         version: profile.onboarding.version,
         step: profile.onboarding.step,
         answers: profile.onboarding.answers,
         skipped: profile.onboarding.skipped,
         completed: profile.onboarding.completed,
      },
      onboardedAt: profile.onboardedAt,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
   };
}

function serializeWorkspace(workspace: Workspace): Record<string, unknown> {
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
