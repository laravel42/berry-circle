import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BerryArtifactService } from '../../agents/artifact-service.ts';
import { postRunResult } from '../../runs/result-comment.ts';
import { enqueueTask } from '../../runs/queue.ts';
import { ApiError } from '../../http/errors.ts';
import { getAgentTool, registerAgentTool, type AgentToolContext } from './registry.ts';

/**
 * The Berry tools every agent has.
 *
 * Each is scoped by the token's claims — the run's issue, the run's workspace
 * — never by an id the model supplies, so an agent cannot point one at
 * another task even by trying.
 */

const MAX_READ_BYTES = 64 * 1024;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const AGENT_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked'] as const;

function issueOf(context: AgentToolContext): string {
   if (!context.task.issueId) throw ApiError.badRequest('this task is not on an issue');
   return context.task.issueId;
}

async function artifactsOf(context: AgentToolContext): Promise<BerryArtifactService> {
   if (!context.storage) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'this deployment has no file storage');
   const [agent] = await context.sql`SELECT name FROM agents WHERE id = ${context.task.agentId}`;
   return new BerryArtifactService({
      sql: context.sql,
      storage: context.storage,
      workspaceId: context.task.workspaceId,
      runId: context.task.runId,
      issueId: issueOf(context),
      agentId: context.task.agentId,
      agentName: (agent?.name as string | undefined) ?? 'agent',
      clock: () => new Date(),
      newId: randomUUID,
   });
}

export function registerCoreAgentTools(): void {
   if (getAgentTool('read_task')) return;

   registerAgentTool('read_task', {
      description: 'Read the task this run is working on: its title, description, status and priority.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const [row] = await context.sql`
            SELECT i.title, i.description, i.status::text AS status, i.priority::text AS priority,
                   berry_issue_identifier(b.workspace_id, i.number) AS identifier
              FROM issues AS i JOIN boards AS b ON b.id = i.board_id
             WHERE i.id = ${issueOf(context)} AND i.deleted_at IS NULL`;
         if (!row) return { found: false };
         return { found: true, ...row };
      },
   });

   registerAgentTool('list_dependencies', {
      description: 'List the tasks this task depends on and the tasks that depend on it.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const issueId = issueOf(context);
         const rows = await context.sql`
            SELECT CASE WHEN edge.issue_id = ${issueId} THEN 'depends_on' ELSE 'blocks' END AS direction,
                   other.title, other.status::text AS status,
                   berry_issue_identifier(ob.workspace_id, other.number) AS identifier
              FROM issue_dependencies AS edge
              JOIN issues AS other
                ON other.id = CASE WHEN edge.issue_id = ${issueId} THEN edge.depends_on_issue_id ELSE edge.issue_id END
               AND other.deleted_at IS NULL
              JOIN boards AS ob ON ob.id = other.board_id
             WHERE edge.issue_id = ${issueId} OR edge.depends_on_issue_id = ${issueId}
             ORDER BY direction, identifier`;
         const ref = (row: Record<string, unknown>) => ({ identifier: row.identifier, title: row.title, status: row.status });
         return {
            dependsOn: rows.filter((row) => row.direction === 'depends_on').map(ref),
            blocks: rows.filter((row) => row.direction === 'blocks').map(ref),
         };
      },
   });

   registerAgentTool('post_comment', {
      description: 'Post a comment on this task, as yourself. Use it to ask a question or report progress.',
      scope: 'task:write',
      inputSchema: z.object({ body: z.string().min(1).max(20_000) }),
      handler: async (context, input) => {
         const comment = await postRunResult(context.sql, {
            issueId: issueOf(context),
            agentId: context.task.agentId,
            text: input.body,
            cut: false,
            occurredAt: new Date().toISOString(),
         });
         return { posted: comment !== null };
      },
   });

   registerAgentTool('set_status', {
      description: 'Move this task to another status. A person always makes the final release decision.',
      scope: 'task:write',
      inputSchema: z.object({ status: z.enum(AGENT_STATUSES) }),
      handler: async (context, input) => {
         await context.issues.update({
            issueId: issueOf(context),
            patch: { status: input.status, descriptionSet: false, dueDateSet: false, assigneeSet: false, projectSet: false },
            actorId: context.task.agentId,
            actorType: 'agent',
         });
         return { status: input.status };
      },
   });

   registerAgentTool('list_files', {
      description: 'List the files saved on this task, including work other agents saved.',
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => ({ files: await (await artifactsOf(context)).listArtifactKeys() }),
   });

   registerAgentTool('read_file', {
      description: 'Read a file saved on this task, by path.',
      scope: 'task:read',
      inputSchema: z.object({ path: z.string().min(1), version: z.number().int().min(0).optional() }),
      handler: async (context, input) => {
         const part = await (await artifactsOf(context)).loadArtifact({
            filename: input.path,
            ...(input.version === undefined ? {} : { version: input.version }),
         });
         if (!part?.inlineData?.data) return { path: input.path, found: false };
         const bytes = Buffer.from(part.inlineData.data, 'base64');
         return {
            path: input.path,
            found: true,
            contentType: part.inlineData.mimeType,
            sizeBytes: bytes.byteLength,
            truncated: bytes.byteLength > MAX_READ_BYTES,
            content: bytes.subarray(0, MAX_READ_BYTES).toString('utf8'),
         };
      },
   });

   registerAgentTool('write_file', {
      description: 'Save a text file on this task. Other agents and people on the task can read it.',
      scope: 'task:write',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      handler: async (context, input) => {
         const version = await (await artifactsOf(context)).saveArtifact({
            filename: input.path,
            artifact: { text: input.content },
         });
         return { path: input.path, version, saved: true };
      },
   });

   registerAgentTool('attach_file', {
      description: 'Attach a binary file (base64) to this task, such as a rendered clip or an image.',
      scope: 'task:write',
      inputSchema: z.object({
         path: z.string().min(1),
         base64: z.string().max(Math.ceil((MAX_ATTACH_BYTES * 4) / 3) + 4),
         contentType: z.string().optional(),
      }),
      handler: async (context, input) => {
         const version = await (await artifactsOf(context)).saveArtifact({
            filename: input.path,
            artifact: {
               inlineData: {
                  data: input.base64,
                  ...(input.contentType ? { mimeType: input.contentType } : {}),
               },
            },
         });
         return { path: input.path, version, sizeBytes: Buffer.from(input.base64, 'base64').byteLength, saved: true };
      },
   });

   registerAgentTool('read_project_resources', {
      description: "Read the project this task belongs to: its name, description and repository.",
      scope: 'task:read',
      inputSchema: z.object({}),
      handler: async (context) => {
         const rows = await context.sql`
            SELECT p.name, p.description, p.status, p.github_repo_full_name AS repository
              FROM issue_project_links AS link
              JOIN projects AS p ON p.id = link.project_id AND p.deleted_at IS NULL
             WHERE link.issue_id = ${issueOf(context)} AND p.workspace_id = ${context.task.workspaceId}`;
         return { projects: rows.map((row) => ({ ...row })) };
      },
   });

   registerAgentTool('mention_agent', {
      description: 'Ask another agent in this workspace to work on this task, with a message.',
      scope: 'task:write',
      inputSchema: z.object({ agentId: z.uuid(), message: z.string().min(1).max(20_000) }),
      handler: async (context, input) => {
         const [agent] = await context.sql`
            SELECT id FROM agents
             WHERE id = ${input.agentId} AND workspace_id = ${context.task.workspaceId} AND archived_at IS NULL`;
         if (!agent) throw ApiError.notFound('Agent');
         await postRunResult(context.sql, {
            issueId: issueOf(context),
            agentId: context.task.agentId,
            text: input.message,
            cut: false,
            occurredAt: new Date().toISOString(),
         });
         // Queued behind this run: the issue holds one active run, so the
         // mention is recorded and picked up when this one ends. Workstream D
         // replaces this with its mention-trigger path.
         return { mentioned: input.agentId, queued: false };
      },
   });
}
