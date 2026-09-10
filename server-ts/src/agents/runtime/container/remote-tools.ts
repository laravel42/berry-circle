import { tool, type JSONSchema, type JSONValue, type Tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ExecutionSession } from '../../../execution/driver.ts';
import { FileTooLarge, getBytes } from '../../../execution/bytes.ts';
import { WORKDIR_KEY } from '../command-tool.ts';

/**
 * Berry's tools, as the server describes them at the start of each task.
 *
 * The container knows no tool by name: whatever `/api/v1/agent-tools` lists
 * for this token becomes a Strands tool whose call is one authenticated POST.
 * A workstream that adds a tool on the server adds it to every agent without
 * an image rebuild.
 */

export interface BerryApi {
   apiUrl: string;
   token: string;
   fetch?: typeof fetch;
}

export class RemoteToolsUnavailable extends Error {
   override readonly name = 'RemoteToolsUnavailable';
}

const manifestSchema = z.object({
   tools: z.array(
      z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })
   ),
});

const MAX_COLLECT_BYTES = 10 * 1024 * 1024;

export async function loadRemoteTools(api: BerryApi): Promise<Tool[]> {
   const doFetch = api.fetch ?? fetch;
   const response = await doFetch(`${base(api)}/api/v1/agent-tools`, {
      headers: { authorization: `Bearer ${api.token}` },
   }).catch((cause: unknown) => {
      throw new RemoteToolsUnavailable(`could not reach Berry: ${message(cause)}`);
   });
   if (!response.ok) throw new RemoteToolsUnavailable(`Berry refused the tool manifest (${response.status})`);
   const parsed = manifestSchema.safeParse(await response.json());
   if (!parsed.success) throw new RemoteToolsUnavailable('Berry sent a tool manifest this runtime cannot read');
   return parsed.data.tools.map((entry) =>
      tool({
         name: entry.name,
         description: entry.description,
         inputSchema: entry.inputSchema as JSONSchema,
         callback: async (input: unknown) => callBerry(api, entry.name, input),
      })
   );
}

export function collectFileTool(api: BerryApi, session: () => Promise<ExecutionSession>): Tool {
   return tool({
      name: 'collect_file',
      description:
         'Save a file from your workspace onto the task, such as a clip ffmpeg wrote. ' +
         'Other agents and people on the task can then read or download it.',
      inputSchema: z.object({
         path: z.string().describe('The file in the workspace, relative to where run_command runs'),
         as: z.string().optional().describe('The path to save it under on the task. Defaults to the same path.'),
      }),
      callback: async ({ path, as }, context?: ToolContext) => {
         const workdir = context?.agent.appState.get(WORKDIR_KEY);
         const cwd = typeof workdir === 'string' ? workdir : undefined;
         try {
            const bytes = await getBytes(await session(), path, { maxBytes: MAX_COLLECT_BYTES, ...(cwd ? { cwd } : {}) });
            if (bytes === null) return { path, found: false, error: `no file at ${path} in the workspace` };
            return await callBerry(api, 'attach_file', {
               path: (as ?? path).trim() || path,
               base64: Buffer.from(bytes).toString('base64'),
            });
         } catch (error) {
            if (error instanceof FileTooLarge) return { path, error: error.message };
            throw error;
         }
      },
   });
}

async function callBerry(api: BerryApi, name: string, input: unknown): Promise<JSONValue> {
   const doFetch = api.fetch ?? fetch;
   const response = await doFetch(`${base(api)}/api/v1/agent-tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input ?? {}),
   });
   const body = (await response.json().catch(() => null)) as { result?: JSONValue; error?: { message?: string } } | null;
   // A refused call is a result the model reads and acts on, like a non-zero
   // exit code; throwing would end the tool as a failure it cannot see.
   if (!response.ok) return { error: body?.error?.message ?? `Berry answered ${response.status}` };
   return body?.result ?? null;
}

/**
 * Saves bytes the container produced (a voiceover, a rendered clip) onto the
 * task through Berry. Unlike a model-facing tool call, a refusal here throws:
 * the media tool that called it reports the failure to the model itself.
 */
export async function callAttach(
   api: BerryApi,
   input: { path: string; base64: string; contentType: string }
): Promise<void> {
   const response = await (api.fetch ?? fetch)(`${base(api)}/api/v1/agent-tools/attach_file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
   });
   if (!response.ok) throw new Error(`Berry refused the file (${response.status})`);
}

function base(api: BerryApi): string {
   return api.apiUrl.replace(/\/+$/, '');
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}
