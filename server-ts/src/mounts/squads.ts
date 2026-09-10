import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentAccess } from '../agents/access.ts';
import type { EnqueueTask } from '../agents/seams.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { SquadRepository } from '../squads/repository.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

/**
 * `/api/v1/squads`: a leader agent and its roster, and giving an issue to one.
 *
 * Every route is scoped to the caller's current workspace through the
 * workspace guard; a squad of another workspace is simply not found.
 */

export interface SquadMountOptions {
   sessions: SessionService;
   sql: Sql;
   squads: SquadRepository;
   issues: IssueRepository;
   /** Workstream A's enqueueTask, injected; absent, an assignment queues nothing. */
   enqueue?: EnqueueTask | null;
   agentAccess?: AgentAccess;
}

const squadSchema = z.strictObject({
   name: z.string().trim().min(1).max(100),
   description: z.string().max(2000).default(''),
   leaderAgentId: z.string().uuid(),
});
const squadPatchSchema = z.strictObject({
   name: z.string().trim().min(1).max(100).optional(),
   description: z.string().max(2000).optional(),
   leaderAgentId: z.string().uuid().optional(),
});
const membersSchema = z.strictObject({
   members: z
      .array(
         z.strictObject({
            type: z.enum(['agent', 'user']),
            id: z.string().uuid(),
            role: z.string().trim().min(1).max(50).default('member'),
         })
      )
      .max(50),
});
const assignSchema = z.strictObject({ issueRef: z.string().min(1).max(100) });

export function squadMounts(options: SquadMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { squads, sql } = options;
   const scope = (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(
         sql,
         user.id,
         currentWorkspace(user.currentWorkspaceId),
         write ? 'product.write' : 'product.read'
      );

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      return json({ nodes: await squads.list(scoped.ctx.workspaceId) });
   });

   route.post('/', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, squadSchema);
      const created = await squads
         .create(scoped.ctx.workspaceId, input, context.get('user').id)
         .catch(rethrowLeader);
      return json(created, 201);
   });

   route.get('/:id', async (context) => {
      const scoped = await scope(context.get('user'), false);
      return json(await squads.get(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad')).catch(rethrow));
   });

   route.patch('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const patch = await readJson(context, squadPatchSchema);
      return json(
         await squads
            .update(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad'), patch)
            .catch(rethrowLeader)
      );
   });

   route.delete('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await squads.archive(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad')).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.put('/:id/members', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const id = pathId(context.req.param('id'), 'Squad');
      const { members } = await readJson(context, membersSchema);
      const ok = await squads.setMembers(scoped.ctx.workspaceId, id, members).catch(rethrow);
      if (!ok) {
         assertValid([fieldError('/members', 'invalid_member', 'Every member must belong to this workspace.')]);
      }
      return json(await squads.get(scoped.ctx.workspaceId, id).catch(rethrow));
   });

   route.post('/:id/assign', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user, true);
      const squad = await squads
         .get(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad'))
         .catch(rethrow);
      if (squad.archivedAt) throw ApiError.notFound('Squad');
      const { issueRef } = await readJson(context, assignSchema);
      const issue = await options.issues.get(issueRef).catch(() => {
         throw ApiError.notFound('Issue');
      });
      const issueScope = await options.issues.authorize(user.id, issue.id, 'product.write').catch(() => {
         throw ApiError.notFound('Issue');
      });
      // The caller may belong to two workspaces: the issue must be in the squad's,
      // or a squad's leader would be assigned to another workspace's issue.
      if (issueScope.workspaceId !== scoped.ctx.workspaceId) throw ApiError.notFound('Issue');
      // Assigning to a squad is assigning to its leader, so the leader's assign scope applies.
      if (options.agentAccess) {
         await options.agentAccess.assertCanAssign({
            workspaceId: scoped.ctx.workspaceId,
            agentId: squad.leaderAgentId,
            userId: user.id,
         });
      }
      await options.issues.update({
         issueId: issue.id,
         patch: {
            descriptionSet: false,
            dueDateSet: false,
            projectSet: false,
            assigneeSet: true,
            assignee: { type: 'agent', id: squad.leaderAgentId },
         },
         actorId: user.id,
      });
      await squads.recordAssignment(scoped.ctx.workspaceId, squad.id, issue.id, user.id);
      const queued = options.enqueue
         ? await options.enqueue(sql, {
              workspaceId: scoped.ctx.workspaceId,
              agentId: squad.leaderAgentId,
              issueId: issue.id,
              kind: 'agent',
              source: 'squad',
           })
         : null;
      return json({ issueId: issue.id, leaderAgentId: squad.leaderAgentId, runId: queued?.runId ?? null });
   });

   return [{ prefix: '/api/v1/squads', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Squad');
   if (error instanceof Conflict) {
      throw new ApiError(409, 'SQUAD_NAME_TAKEN', 'A squad with that name already exists.');
   }
   throw error;
}

/** On create/update a foreign key miss means the leader is not an agent of this workspace. */
function rethrowLeader(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Agent');
   return rethrow(error);
}
