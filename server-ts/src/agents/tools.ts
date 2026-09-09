import { randomUUID } from 'node:crypto';
import { tool, type Tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import type { BerryArtifactService } from './artifact-service.ts';
import { runCommandTool, WORKDIR_KEY, type CommandToolScope } from './command-tool.ts';
import { FileTooLarge, getBytes } from '../execution/bytes.ts';
import { ExecutionUnavailable } from '../execution/driver.ts';

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
      tools.push(collectFile(scope, scope.commands.session));
   }
   return tools;
}

/** The most a command-produced file can be brought back at: the bucket's own ceiling. */
const MAX_COLLECT_BYTES = 25 * 1024 * 1024;

/**
 * Brings a file a command produced back onto the task.
 *
 * `write_file` carries text the model composes; a clip ffmpeg wrote is bytes
 * in the workspace that the model never sees. This is the other half of the
 * bridge: the file is read out of the workspace and saved as an artifact,
 * where the task page lists it and the next run finds it.
 */
function collectFile(scope: ToolScope, session: () => Promise<ExecutionSessionLike>): Tool {
   return tool({
      name: 'collect_file',
      description:
         'Save a file from your workspace onto the task — the way to keep a file a command produced, ' +
         'such as a clip ffmpeg wrote. Other agents and people on the task can then read or download it.',
      inputSchema: z.object({
         path: z.string().describe('The file in the workspace, relative to where run_command runs, e.g. output/final.mp4'),
         as: z.string().optional().describe('The path to save it under on the task. Defaults to the same path.'),
      }),
      callback: async ({ path, as }, context?: ToolContext) => {
         const workdir = context?.agent.appState.get(WORKDIR_KEY);
         const cwd = typeof workdir === 'string' ? workdir : undefined;
         try {
            const bytes = await getBytes(await session(), path, { maxBytes: MAX_COLLECT_BYTES, ...(cwd ? { cwd } : {}) });
            if (bytes === null) return { path, found: false, error: `no file at ${path} in the workspace` };
            const saved = (as ?? path).trim() || path;
            const version = await scope.artifacts.saveArtifact({
               filename: saved,
               // No type given: it is sniffed from the bytes, the same as a
               // text write with no type.
               artifact: { inlineData: { data: Buffer.from(bytes).toString('base64') } },
            });
            return { path: saved, version, sizeBytes: bytes.byteLength, saved: true };
         } catch (error) {
            if (error instanceof FileTooLarge) return { path, error: error.message };
            if (error instanceof ExecutionUnavailable) return { path, error: `no workspace is available: ${error.message}` };
            throw error;
         }
      },
   });
}

type ExecutionSessionLike = Parameters<typeof getBytes>[0];

/** What this run has produced so far, including by other agents. */
function listFiles(scope: ToolScope): Tool {
   return tool({
      name: 'list_files',
      description:
         'List the files produced for this task. Includes work saved by other agents on the same task.',
      inputSchema: z.object({}),
      callback: async () => ({ files: await scope.artifacts.listArtifactKeys() }),
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
