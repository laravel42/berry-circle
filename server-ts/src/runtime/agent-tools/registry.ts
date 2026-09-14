import { z } from 'zod';
import type { Sql } from '../../db/pool.ts';
import type { IssueRepository } from '../../core/issues.ts';
import type { ProjectRepository } from '../../core/projects.ts';
import type { Storage } from '../../storage/storage.ts';
import type { TaskClaims, TaskScope } from './tokens.ts';

/**
 * The tools an agent uses to act on Berry, registered by whichever module
 * owns the product surface they touch.
 *
 * The runtime fetches the manifest at the start of each task and turns every
 * entry into a Strands tool, so a workstream adds an agent capability here and
 * never touches the container image.
 */

export interface AgentToolContext {
   sql: Sql;
   storage: Storage | null;
   issues: Pick<IssueRepository, 'create' | 'update'>;
   projects: Pick<ProjectRepository, 'create'>;
   task: TaskClaims;
}

export interface AgentToolDefinition<S extends z.ZodObject> {
   description: string;
   scope: TaskScope;
   inputSchema: S;
   handler: (context: AgentToolContext, input: z.output<S>) => Promise<unknown>;
}

export type ToolRun =
   | { ok: true; result: unknown }
   | { ok: false; issues: Array<{ path: string; message: string }> };

export interface RegisteredAgentTool {
   name: string;
   description: string;
   scope: TaskScope;
   jsonSchema: Record<string, unknown>;
   run: (context: AgentToolContext, raw: unknown) => Promise<ToolRun>;
}

export class AgentToolConflict extends Error {
   override readonly name = 'AgentToolConflict';
}

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const tools = new Map<string, RegisteredAgentTool>();

export function registerAgentTool<S extends z.ZodObject>(name: string, def: AgentToolDefinition<S>): void {
   if (!NAME.test(name)) throw new Error(`tool name '${name}' must match ${NAME}`);
   if (tools.has(name)) throw new AgentToolConflict(`an agent tool named '${name}' is already registered`);
   tools.set(name, {
      name,
      description: def.description,
      scope: def.scope,
      jsonSchema: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
      run: async (context, raw) => {
         const parsed = def.inputSchema.safeParse(raw ?? {});
         if (!parsed.success) {
            return {
               ok: false,
               issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
               })),
            };
         }
         return { ok: true, result: await def.handler(context, parsed.data) };
      },
   });
}

export function listAgentTools(): RegisteredAgentTool[] {
   return [...tools.values()];
}

export function getAgentTool(name: string): RegisteredAgentTool | null {
   return tools.get(name) ?? null;
}
