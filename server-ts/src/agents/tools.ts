import { randomUUID } from 'node:crypto';
import { tool, type Tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import type { BerryArtifactService } from './artifact-service.ts';
import { runCommandTool, type CommandToolScope } from './command-tool.ts';

/**
 * The tools an agent gets, built per run with its workspace already in scope.
 *
 * This is a seam the previous runtime never had. There, an agent was a
 * separate process with no per-workspace credential store, so it could not act
 * as the workspace — which is why delivery was Berry's job rather than the
 * agent's, and why agents could not touch anything outside their own
 * directory.
 *
 * Here a tool is a closure. The workspace, run and issue are captured when the
 * tool is constructed, so an agent cannot name another workspace: there is no
 * parameter for it. That is the whole security model, and it is worth more
 * than any amount of checking inside the handler.
 */

export interface ToolScope {
   sql: Sql;
   artifacts: BerryArtifactService;
   workspaceId: string;
   issueId: string;
   /** Bounds what a single read can pull into the prompt. */
   maxBytes?: number;
   /**
    * A workspace to run commands in, when the deployment has one.
    *
    * Absent means the agent simply does not have `run_command`, rather than
    * having one that fails on every call. An agent cannot work around a tool
    * it was never given, and being told a capability exists and then refused
    * is how a run burns tokens rediscovering the same wall.
    */
   commands?: Omit<CommandToolScope, 'newId'> & { newId?: () => string };
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export function berryTools(scope: ToolScope): Tool[] {
   const tools = [
      listFiles(scope),
      readFile(scope),
      writeFile(scope),
      readIssue(scope),
      listDependencies(scope),
   ];
   if (scope.commands) {
      tools.push(runCommandTool({ ...scope.commands, newId: scope.commands.newId ?? randomUUID }));
   }
   return tools;
}

/** What this run has produced so far, including by other agents. */
function listFiles(scope: ToolScope): Tool {
   return tool({
      name: 'list_files',
      description:
         'List the files produced for this task. Includes work saved by other agents on the same task.',
      inputSchema: z.object({}),
      callback: async () => ({ files: await scope.artifacts.listArtifactKeys(artifactKey()) }),
   });
}

/**
 * Reads a file another agent may have written.
 *
 * Bounded, and truncation is reported rather than hidden. An agent shown the
 * first half of a file with no indication is an agent reasoning confidently
 * about something it has not seen — which is exactly how the reviewer came to
 * reject good work when it was quietly given 8 files out of 22.
 */
function readFile(scope: ToolScope): Tool {
   const maxBytes = scope.maxBytes ?? DEFAULT_MAX_BYTES;
   return tool({
      name: 'read_file',
      description: 'Read a file produced for this task, by path.',
      inputSchema: z.object({
         path: z.string().describe('The file path, as returned by list_files'),
         version: z.number().int().min(0).optional().describe('Defaults to the newest'),
      }),
      callback: async ({ path, version }) => {
         const part = await scope.artifacts.loadArtifact({
            ...artifactKey(),
            filename: path,
            ...(version === undefined ? {} : { version }),
         });
         if (!part?.inlineData?.data) return { path, found: false };

         const bytes = Buffer.from(part.inlineData.data, 'base64');
         const truncated = bytes.byteLength > maxBytes;
         return {
            path,
            found: true,
            contentType: part.inlineData.mimeType,
            sizeBytes: bytes.byteLength,
            truncated,
            content: bytes.subarray(0, maxBytes).toString('utf8'),
            ...(truncated
               ? { note: `Only the first ${maxBytes} bytes are shown; the file is longer.` }
               : {}),
         };
      },
   });
}

/** Saves work where the next agent can find it. */
function writeFile(scope: ToolScope): Tool {
   return tool({
      name: 'write_file',
      description:
         'Save a file for this task. Other agents working on the same task can read it.',
      inputSchema: z.object({
         path: z.string().describe('A relative path, e.g. src/index.ts or notes/findings.md'),
         content: z.string(),
      }),
      callback: async ({ path, content }) => {
         const version = await scope.artifacts.saveArtifact({
            ...artifactKey(),
            filename: path,
            artifact: { text: content },
         });
         return { path, version, saved: true };
      },
   });
}

/**
 * The task itself.
 *
 * Scoped by construction: the issue id is captured, so this cannot be pointed
 * at another task even by an agent that tries.
 */
function readIssue(scope: ToolScope): Tool {
   return tool({
      name: 'read_task',
      description: 'Read the task this run is working on: its title, description and status.',
      inputSchema: z.object({}),
      callback: async () => {
         const [row] = await scope.sql`
            SELECT i.title, i.description, i.status::text AS status, i.priority::text AS priority,
                   berry_issue_identifier(b.workspace_id, i.number) AS identifier
              FROM issues AS i
              JOIN boards AS b ON b.id = i.board_id
             WHERE i.id = ${scope.issueId} AND i.deleted_at IS NULL`;
         if (!row) return { found: false };
         return {
            found: true,
            identifier: row.identifier,
            title: row.title,
            description: row.description,
            status: row.status,
            priority: row.priority,
         };
      },
   });
}

/**
 * What this task waits on, and what waits on it.
 *
 * An agent that knows a blocker is unfinished can say so instead of inventing
 * the part it cannot see.
 */
function listDependencies(scope: ToolScope): Tool {
   return tool({
      name: 'list_dependencies',
      description: 'List the tasks this task depends on and the tasks that depend on it.',
      inputSchema: z.object({}),
      callback: async () => {
         const rows = await scope.sql`
            SELECT CASE WHEN edge.issue_id = ${scope.issueId} THEN 'depends_on' ELSE 'blocks' END AS direction,
                   other.title, other.status::text AS status,
                   berry_issue_identifier(other_board.workspace_id, other.number) AS identifier
              FROM issue_dependencies AS edge
              JOIN issues AS other
                ON other.id = CASE WHEN edge.issue_id = ${scope.issueId}
                                   THEN edge.depends_on_issue_id ELSE edge.issue_id END
               AND other.deleted_at IS NULL
              JOIN boards AS other_board ON other_board.id = other.board_id
             WHERE edge.issue_id = ${scope.issueId} OR edge.depends_on_issue_id = ${scope.issueId}
             ORDER BY direction, identifier`;

         return {
            dependsOn: rows.filter((row) => row.direction === 'depends_on').map(toRef),
            blocks: rows.filter((row) => row.direction === 'blocks').map(toRef),
         };
      },
   });
}

function toRef(row: Record<string, unknown>) {
   return { identifier: row.identifier, title: row.title, status: row.status };
}

/**
 * ADK addresses artifacts by session, but Berry scopes them to the run.
 *
 * The service was constructed with that run, so these values only satisfy the
 * interface — changing them would not reach another run's files.
 */
function artifactKey() {
   return { appName: 'berry', userId: 'agent', sessionId: 'run' };
}
