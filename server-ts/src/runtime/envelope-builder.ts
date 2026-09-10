import type { Sql } from '../db/pool.ts';
import type { RunMemory } from '../agentcore/memory.ts';
import { recallPrompt } from '../agentcore/memory.ts';
import type { GitHubClient } from '../integrations/github.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { branchName, parseRepository } from '../agents/checkout.ts';
import { permissionsOf } from '../agents/permissions.ts';
import { buildMessage, lastRejection } from '../agents/prompt.ts';
import { repositoryForIssue } from '../agents/repository-context.ts';
import { loadIssue } from '../agents/repository-run.ts';
import type { Dispatch } from '../runs/ledger.ts';
import type { RepoPlan, TaskEnvelope, TranscriptMessage } from './envelope.ts';
import { runtimeSessionIdFor, sessionKeyFor } from './session-id.ts';
import { buildTranscript } from './transcript.ts';
import { loadAgentExtensions, type ExtensionDeps } from '../agents/extensions.ts';

export interface CompletionSpec {
   purpose: string;
   system: string;
   jsonSchema: Record<string, unknown> | null;
   model: string | null;
   /** A multi-turn exchange before the prompt (chat replies). */
   transcript?: TranscriptMessage[];
}

export interface TaskRow {
   runId: string;
   workspaceId: string;
   agentId: string;
   issueId: string | null;
   boardId: string | null;
   chatSessionId: string | null;
   kind: 'agent' | 'completion';
   source: string;
   prompt: string | null;
   completionSpec: CompletionSpec | null;
   runtimeId: string | null;
}

export interface AgentConfig {
   id: string;
   name: string;
   instructions: string;
   model: string;
   permissions: string[];
   runtimeProfileId: string | null;
}

/** What the server needs after the runtime pushed, to open the pull request. */
export interface DeliveryPlan {
   fullName: string;
   defaultBranch: string;
   branch: string;
   reference: string;
   title: string;
   mergeRequiresApproval: boolean;
   mayOpenPullRequest: boolean;
}

export interface EnvelopeDeps {
   sql: Sql;
   /** `BERRY_PUBLIC_URL`: where the runtime calls the Berry tool API. */
   publicUrl: string;
   defaultModel: string;
   memory: RunMemory;
   sealer: Sealer | null;
   gitCredential?: ((workspaceId: string) => Promise<{ username: string; password: string; canPush?: boolean }>) | undefined;
   github: (token: string) => GitHubClient;
   /**
    * The agent's skills, MCP servers, env and squad briefing (workstream D).
    * Absent: the agent carries none of them.
    */
   extensions?: Omit<ExtensionDeps, 'sql'> | undefined;
   /** Servers left out for want of a gateway, by name only. */
   onSkipped?: ((names: string[]) => void) | undefined;
}

export async function loadTask(sql: Sql, runId: string): Promise<TaskRow> {
   const [row] = await sql`
      SELECT id, workspace_id, agent_id, issue_id, board_id, chat_session_id, kind, source,
             prompt, completion_spec, runtime_id
        FROM runs WHERE id = ${runId}`;
   if (!row) throw new Error(`run ${runId} does not exist`);
   return {
      runId: row.id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      issueId: (row.issue_id as string | null) ?? null,
      boardId: (row.board_id as string | null) ?? null,
      chatSessionId: (row.chat_session_id as string | null) ?? null,
      kind: row.kind as TaskRow['kind'],
      source: row.source as string,
      prompt: (row.prompt as string | null) ?? null,
      completionSpec: (row.completion_spec as CompletionSpec | null) ?? null,
      runtimeId: (row.runtime_id as string | null) ?? null,
   };
}

export class EnvelopeBuilder {
   readonly #deps: EnvelopeDeps;

   constructor(deps: EnvelopeDeps) {
      this.#deps = deps;
   }

   async build(input: { task: TaskRow; dispatch: Dispatch | null; token: string }): Promise<{
      envelope: TaskEnvelope;
      delivery: DeliveryPlan | null;
      model: string;
   }> {
      const { task } = input;
      const agent = await this.#agent(task.agentId);
      const profile = await this.#profile(agent.runtimeProfileId, task.workspaceId);
      const model =
         (task.kind === 'completion' ? task.completionSpec?.model : null) ?? (agent.model || profile.model || this.#deps.defaultModel);
      // An agent task carries its extensions; a completion is one model call
      // and carries none.
      const extensions =
         task.kind === 'agent' && this.#deps.extensions
            ? await loadAgentExtensions(
                 { sql: this.#deps.sql, ...this.#deps.extensions },
                 { workspaceId: task.workspaceId, agentId: task.agentId, issueId: task.issueId }
              )
            : null;
      if (extensions && extensions.skipped.length > 0) this.#deps.onSkipped?.(extensions.skipped);
      const instructions = extensions?.squadBriefing
         ? `${agent.instructions}\n\n<berry_squad_briefing>\n${extensions.squadBriefing}\n</berry_squad_briefing>`
         : agent.instructions;
      const sessionKey = sessionKeyFor({
         kind: task.kind, runId: task.runId, agentId: task.agentId, issueId: task.issueId, chatSessionId: task.chatSessionId,
      });

      const base = {
         runId: task.runId,
         sessionKey,
         runtimeSessionId: runtimeSessionIdFor(sessionKey),
         agent: {
            name: agent.name,
            instructions,
            model,
            // EnvelopeSkill and EnvelopeMcpServer are SkillRef and McpServerRef
            // field for field: no mapping, and tsc refuses a drift.
            skills: extensions?.skills ?? [],
            mcpServers: extensions?.mcpServers ?? [],
            permissions: agent.permissions,
            maxTokens: null,
            temperature: null,
         },
         // The runtime profile's env first; the agent's own env wins a clash.
         env: { ...profile.env, ...(extensions?.env ?? {}) },
         berry: { apiUrl: this.#deps.publicUrl, token: input.token },
      };

      if (task.kind === 'completion') {
         const spec = task.completionSpec ?? { purpose: 'completion', system: '', jsonSchema: null, model: null };
         return {
            model,
            delivery: null,
            envelope: {
               ...base,
               kind: 'completion',
               task: { prompt: task.prompt ?? '', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
               transcript: spec.transcript ?? [],
               repo: null,
               completion: { system: spec.system, jsonSchema: spec.jsonSchema },
            },
         };
      }

      const transcript = await buildTranscript(this.#deps.sql, {
         agentId: task.agentId, issueId: task.issueId, chatSessionId: task.chatSessionId, excludeRunId: task.runId,
      });

      if (!task.issueId) {
         // A chat task: the prompt is the message; workstream D adds the chat context.
         return {
            model,
            delivery: null,
            envelope: {
               ...base,
               kind: 'agent',
               task: { prompt: task.prompt ?? '', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
               transcript,
               repo: null,
               completion: null,
            },
         };
      }

      // An issue task always carries its issue, claimed or not: a caller that
      // builds an envelope without the ledger's claim (a preview, a retry
      // path) still gets the issue prompt rather than a bare message.
      const dispatch = input.dispatch ?? (await this.#readDispatch(task.runId));
      const [reviewFeedback, recalled, comments, dependencies, projectResources] = await Promise.all([
         lastRejection(this.#deps.sql, dispatch.issueId),
         this.#deps.memory.recall({ agentId: task.agentId, issueId: dispatch.issueId }),
         this.#comments(dispatch.issueId),
         this.#dependencies(dispatch.issueId),
         this.#projectResources(dispatch.issueId, task.workspaceId),
      ]);
      const priorWork = recallPrompt(recalled);
      const { repo, delivery } = await this.#repository(task, dispatch, agent);
      return {
         model,
         delivery,
         envelope: {
            ...base,
            kind: 'agent',
            task: {
               prompt: buildMessage({ ...dispatch, reviewFeedback, ...(priorWork ? { priorWork } : {}) }),
               issue: {
                  id: dispatch.issueId,
                  identifier: dispatch.issueIdentifier,
                  title: dispatch.issueTitle,
                  description: dispatch.issueDescription,
               },
               comments,
               dependencies,
               projectResources,
               priorWork,
            },
            transcript,
            repo,
            completion: null,
         },
      };
   }

   /** The issue context `claimDispatch` reads, without the claim: building an envelope changes no run state. */
   async #readDispatch(runId: string): Promise<Dispatch> {
      const [row] = await this.#deps.sql`
         SELECT r.id, r.issue_id, r.board_id, r.agent_id,
                i.title, i.description, r.instructions, r.request_id, r.traceparent,
                b.workspace_id,
                COALESCE(project.github_repo_full_name, '') AS repository,
                berry_issue_identifier(b.workspace_id, i.number) AS identifier
           FROM runs AS r
           JOIN issues AS i ON i.id = r.issue_id
           JOIN boards AS b ON b.id = r.board_id
           LEFT JOIN issue_project_links AS link ON link.issue_id = i.id
           LEFT JOIN projects AS project
             ON project.id = link.project_id AND project.deleted_at IS NULL
          WHERE r.id = ${runId}`;
      if (!row) throw new Error(`run ${runId} is not on an issue`);
      return {
         runId: row.id as string,
         issueId: row.issue_id as string,
         boardId: row.board_id as string,
         workspaceId: row.workspace_id as string,
         agentId: row.agent_id as string,
         issueTitle: row.title as string,
         issueDescription: (row.description as string | null) ?? null,
         issueIdentifier: row.identifier as string,
         instructions: (row.instructions as string | null) ?? null,
         repository: (row.repository as string) ?? '',
         requestId: (row.request_id as string | null) ?? '',
         traceParent: (row.traceparent as string | null) ?? '',
      };
   }

   async #agent(agentId: string): Promise<AgentConfig> {
      const [row] = await this.#deps.sql`
         SELECT id, name, instructions, model_name, permissions, runtime_profile_id
           FROM agents WHERE id = ${agentId} AND archived_at IS NULL`;
      if (!row) throw new Error(`agent ${agentId} does not exist`);
      const name = row.name as string;
      return {
         id: row.id as string,
         name,
         instructions:
            ((row.instructions as string | null) ?? '').trim() ||
            `You are ${name}, an agent working a task in Berry. Do the task you are given and report what you did.`,
         model: (row.model_name as string | null) ?? '',
         permissions: (row.permissions as string[] | null) ?? [],
         runtimeProfileId: (row.runtime_profile_id as string | null) ?? null,
      };
   }

   async #profile(profileId: string | null, workspaceId: string): Promise<{ env: Record<string, string>; model: string | null }> {
      if (!profileId) return { env: {}, model: null };
      // Scoped to the task's workspace: `agents.runtime_profile_id` is a plain
      // FK, so without this a mis-bound agent would open another tenant's env.
      const [row] = await this.#deps.sql`
         SELECT env_sealed, model_default FROM runtime_profiles
          WHERE id = ${profileId} AND workspace_id = ${workspaceId}`;
      if (!row) return { env: {}, model: null };
      const sealed = row.env_sealed as Buffer | null;
      const env = sealed && this.#deps.sealer ? (JSON.parse(this.#deps.sealer.open(sealed)) as Record<string, string>) : {};
      return { env, model: (row.model_default as string | null) ?? null };
   }

   async #comments(issueId: string): Promise<TaskEnvelope['task']['comments']> {
      const rows = await this.#deps.sql`
         SELECT c.body, c.created_at, c.author_type::text AS author_type,
                COALESCE(u.name, a.name, 'someone') AS author
           FROM comments AS c
           LEFT JOIN users AS u ON c.author_type = 'user' AND u.id = c.author_id
           LEFT JOIN agents AS a ON c.author_type = 'agent' AND a.id = c.author_id
          WHERE c.issue_id = ${issueId}
          ORDER BY c.created_at DESC LIMIT 30`;
      return rows.reverse().map((row) => ({
         author: row.author as string,
         body: row.body as string,
         createdAt: new Date(row.created_at as string).toISOString(),
      }));
   }

   /** Spec 2.2: the envelope carries the issue's dependencies (same query as the `list_dependencies` tool). */
   async #dependencies(issueId: string): Promise<TaskEnvelope['task']['dependencies']> {
      const rows = await this.#deps.sql`
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
      return rows.map((row) => ({
         identifier: row.identifier as string,
         title: row.title as string,
         status: row.status as string,
         direction: row.direction as 'depends_on' | 'blocks',
      }));
   }

   /** Spec 2.2: the envelope carries the project resources (same rows as `read_project_resources`). */
   async #projectResources(issueId: string, workspaceId: string): Promise<TaskEnvelope['task']['projectResources']> {
      const rows = await this.#deps.sql`
         SELECT p.name, p.description, p.github_repo_full_name AS repository
           FROM issue_project_links AS link
           JOIN projects AS p ON p.id = link.project_id AND p.deleted_at IS NULL
          WHERE link.issue_id = ${issueId} AND p.workspace_id = ${workspaceId}`;
      return rows.map((row) => ({
         title: row.name as string,
         url: row.repository ? `https://github.com/${row.repository as string}` : null,
         content: (row.description as string | null) ?? null,
      }));
   }

   async #repository(task: TaskRow, dispatch: Dispatch, agent: AgentConfig): Promise<{ repo: RepoPlan | null; delivery: DeliveryPlan | null }> {
      if (!this.#deps.gitCredential) return { repo: null, delivery: null };
      const repository = await repositoryForIssue(this.#deps.sql, dispatch.issueId);
      if (!repository) return { repo: null, delivery: null };
      const permissions = permissionsOf(agent.permissions, agent.name);
      // Before a credential is opened: an agent that may not read the
      // repository never causes a token to be minted on its behalf.
      permissions.require('read_repository');
      permissions.require('create_branches');
      const credential = await this.#deps.gitCredential(task.workspaceId);
      const { owner, name } = parseRepository(repository.fullName);
      const remote = await this.#deps.github(credential.password).repository(owner, name);
      if (!(credential.canPush ?? remote.canPush)) {
         throw new Error(`the GitHub connection cannot push to ${repository.fullName}`);
      }
      const issue = await loadIssue(this.#deps.sql, dispatch.issueId);
      const branch = branchName(agent.name, issue.reference, issue.title);
      return {
         repo: {
            fullName: repository.fullName,
            branch,
            baseBranch: remote.defaultBranch,
            credential: { username: credential.username, password: credential.password },
            verifyCommands: repository.verifyCommands,
            issueReference: issue.reference,
            issueTitle: issue.title,
         },
         delivery: {
            fullName: repository.fullName,
            defaultBranch: remote.defaultBranch,
            branch,
            reference: issue.reference,
            title: issue.title,
            mergeRequiresApproval: !permissions.has('merge_without_approval'),
            mayOpenPullRequest: permissions.has('open_pull_requests'),
         },
      };
   }
}
