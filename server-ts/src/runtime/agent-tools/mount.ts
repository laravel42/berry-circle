import { Hono } from 'hono';
import type { Sql } from '../../db/pool.ts';
import type { IssueRepository } from '../../core/issues.ts';
import type { ProjectRepository } from '../../core/projects.ts';
import { json } from '../../http/app.ts';
import { ApiError } from '../../http/errors.ts';
import type { Mount } from '../../http/registry.ts';
import type { Storage } from '../../storage/storage.ts';
import { registerCoreAgentTools } from './core-tools.ts';
import { getAgentTool, listAgentTools } from './registry.ts';
import { resolveTaskToken, type TaskClaims } from './tokens.ts';

/**
 * `/api/v1/agent-tools`: the only way an agent in a runtime acts on Berry.
 *
 * Authenticated by a task token alone. A session or personal token is
 * refused here, and a task token is refused everywhere else, because
 * `requireSession` dispatches by prefix and has no `berry_task_` branch.
 */
export function agentToolMounts(options: {
   sql: Sql;
   storage: Storage | null;
   issues: Pick<IssueRepository, 'create' | 'update'>;
   projects: Pick<ProjectRepository, 'create'>;
}): Mount[] {
   registerCoreAgentTools();
   const route = new Hono<{ Variables: { task: TaskClaims } }>();

   route.use('*', async (context, next) => {
      const header = context.req.header('authorization') ?? '';
      const match = /^Bearer (\S+)$/.exec(header);
      const claims = match?.[1] ? await resolveTaskToken(options.sql, match[1]).catch(() => null) : null;
      if (!claims) throw ApiError.unauthorized();
      context.set('task', claims);
      await next();
   });

   route.get('/', (context) => {
      const scopes = context.get('task').scopes;
      return json({
         tools: listAgentTools()
            .filter((tool) => scopes.includes(tool.scope))
            .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.jsonSchema })),
      });
   });

   route.post('/:name', async (context) => {
      const task = context.get('task');
      const tool = getAgentTool(context.req.param('name'));
      if (!tool || !task.scopes.includes(tool.scope)) throw ApiError.notFound('Tool');
      let body: unknown;
      try {
         body = await context.req.json();
      } catch {
         throw ApiError.badRequest('the request body must be JSON');
      }
      const outcome = await tool.run(
         { sql: options.sql, storage: options.storage, issues: options.issues, projects: options.projects, task },
         body
      );
      if (!outcome.ok) throw ApiError.badRequest('the tool input is not valid', { issues: outcome.issues });
      return json({ result: outcome.result });
   });

   return [{ prefix: '/api/v1/agent-tools', handler: route }];
}
