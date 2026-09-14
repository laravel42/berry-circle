import { createHash, randomUUID } from 'node:crypto';
import type { AwsCredentials } from '../model.ts';
import { join } from 'node:path';
import type { McpClient, Tool } from '@strands-agents/sdk';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { TaskDelivery } from '../../../runtime/lifecycle.ts';
import type { ExecutionSession } from '../../../execution/driver.ts';
import { runCommandTool, WORKDIR_KEY } from '../command-tool.ts';
import { permissionsOf, type Permission } from '../../permissions.ts';
import { buildRunAgent } from '../agent.ts';
import { classify } from '../failure.ts';
import type { ModelFactory } from '../model.ts';
import { AccountingPlugin } from '../plugins/accounting.ts';
import { LedgerPlugin } from '../plugins/ledger.ts';
import { PermissionPlugin, TOOL_PERMISSIONS } from '../plugins/permissions.ts';
import { ToolOutcomePlugin } from '../plugins/tool-outcome.ts';
import { MAX_SUMMARY_BYTES } from '../result-text.ts';
import { truncateUtf8 } from '../utf8.ts';
import { runCompletionTask } from './completion-task.ts';
import { toConversation } from './conversation.ts';
import { emitterSink, type Emit } from './emitter.ts';
import { LocalSession } from './local-session.ts';
import { mediaTools, type VideoOutput } from '../tools/media.ts';
import {
   RemoteToolsUnavailable,
   callAttach,
   collectFileTool,
   loadRemoteTools,
   type BerryApi,
} from './remote-tools.ts';
import type { SessionRegistry } from './sessions.ts';
import {
   loadMcpClients,
   mcpToolPermissions,
   registrableMcpTools,
   type EnvelopeMcpServerLike,
   type Warn,
} from '../mcp-clients.ts';
import { writeSkills } from '../skill-files.ts';

/**
 * One task envelope, worked to a terminal lifecycle event.
 *
 * Warm or cold is decided here and nowhere else. The same envelope works
 * either way — it always carries the transcript — and only speed differs: a
 * warm session keeps its full Strands messages (tool calls included), a cold
 * one restores the text of earlier turns from what Berry recorded.
 */

export interface RepositoryStep {
   /** Clones or refreshes the checkout; returns its directory, or null without a repo. */
   prepare(input: { envelope: TaskEnvelope; session: LocalSession; warm: boolean; emit: Emit }): Promise<string | null>;
   deliver(input: {
      envelope: TaskEnvelope;
      session: LocalSession;
      directory: string;
      summary: string | null;
      emit: Emit;
   }): Promise<TaskDelivery | null>;
}

export interface HandlerDeps {
   registry: SessionRegistry;
   modelFactory: ModelFactory;
   region: string;
   /**
    * The AWS credential Polly and Nova Reel render with.
    *
    * Passed explicitly rather than left to the default chain: the image ships
    * no credential file and no instance role, so a null here means every
    * media call fails with "Could not load credentials from any providers"
    * while the model itself works, because the model is handed the same
    * credential through modelFactory.
    */
   credentials?: AwsCredentials | null;
   /** Where session workspaces live: `/mnt/workspace` in the image. */
   workRoot: string;
   fetch?: typeof fetch;
   loadTools?: (api: BerryApi) => Promise<Tool[]>;
   repository?: RepositoryStep;
   /** Where the video job writes. Absent means agents get no video tool. */
   videoOutput?: VideoOutput | undefined;
   /** Connects the agent's MCP servers. Injected by tests; production uses Strands clients. */
   loadMcp?: (servers: EnvelopeMcpServerLike[]) => Promise<McpClient[]>;
   /** Where a dropped MCP tool is reported. Defaults to a JSON line on stderr. */
   warn?: Warn;
}

const consoleWarn: Warn = (message, fields) => console.warn(JSON.stringify({ level: 'WARN', msg: message, ...fields }));

export async function handleInvocation(envelope: TaskEnvelope, emit: Emit, deps: HandlerDeps): Promise<void> {
   let ended = false;
   const say: Emit = (event) => {
      if (ended) return;
      if (event.type === 'task.completed' || event.type === 'task.failed') ended = true;
      emit(event);
   };
   if (envelope.kind === 'completion') {
      // Fresh by construction: no registry, so nothing warm is read or kept.
      await runCompletionTask(envelope, say, deps);
      return;
   }
   await deps.registry.exclusive(envelope.runtimeSessionId, (signal) => runAgentTask(envelope, say, deps, signal));
}

async function runAgentTask(envelope: TaskEnvelope, emit: Emit, deps: HandlerDeps, signal: AbortSignal): Promise<void> {
   emit({ type: 'task.started' });
   const key = envelope.runtimeSessionId;
   const fingerprint = agentFingerprint(envelope);
   const held = deps.registry.get(key);
   const warm = held !== undefined && held.fingerprint === fingerprint;
   const workspace =
      held?.workspace ?? new LocalSession({ id: key, root: join(deps.workRoot, key), env: envelope.env });
   const sink = emitterSink(emit);
   const accounting = new AccountingPlugin();
   const ledger = new LedgerPlugin({ ledger: sink, runId: envelope.runId });
   const outcome = new ToolOutcomePlugin();
   const api: BerryApi = { ...envelope.berry, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
   let mcpClients: McpClient[] = [];

   try {
      // The agent's skills, laid out where skill-aware tools look, and its
      // MCP servers as Strands clients beside Berry's own tools.
      await writeSkills(join(deps.workRoot, key), envelope.agent.skills);
      mcpClients = await (deps.loadMcp ?? loadMcpClients)(envelope.agent.mcpServers);
      // Whatever the loader threw, a task that cannot read its tools never
      // runs toolless: it fails retryable, as Berry being unreachable.
      const remote = await (deps.loadTools ?? loadRemoteTools)(api).catch((cause: unknown) => {
         if (cause instanceof RemoteToolsUnavailable) throw cause;
         throw new RemoteToolsUnavailable(
            `could not load Berry's tools: ${cause instanceof Error ? cause.message : String(cause)}`
         );
      });
      const session = async (): Promise<ExecutionSession> => workspace;
      const tools: Tool[] = [
         runCommandTool({ ledger: sink, runId: envelope.runId, session, newId: randomUUID }),
         collectFileTool(api, session),
         ...remote,
         // Speech and video render here, with the runtime's own role, and
         // land on the task through Berry like any other file.
         ...mediaTools({
            region: deps.region,
            credentials: deps.credentials ?? null,
            runId: envelope.runId,
            video: deps.videoOutput,
            save: async ({ path, bytes, contentType }) => {
               await callAttach(api, { path, base64: Buffer.from(bytes).toString('base64'), contentType });
            },
         }),
      ];
      // MCP tools are registered as tools, not as clients, so one whose name
      // clashes with a built-in is dropped here instead of failing the task.
      const mcp = await registrableMcpTools(
         mcpClients,
         tools.map((t) => t.name),
         deps.warn ?? consoleWarn
      );
      const table = toolTable(envelope.agent.mcpServers, mcp.listed, remote.map((t) => t.name));

      const directory = deps.repository
         ? await deps.repository.prepare({ envelope, session: workspace, warm, emit })
         : null;

      const agent = buildRunAgent(
         {
            agentName: envelope.agent.name,
            model: envelope.agent.model,
            region: deps.region,
            // The runtime's execution role; there is no key in the envelope.
            credentials: null,
            systemPrompt: envelope.agent.instructions,
            tools: [...tools, ...mcp.tools],
            plugins: [
               ledger,
               accounting,
               new PermissionPlugin({
                  permissions: permissionsOf(envelope.agent.permissions, envelope.agent.name),
                  table,
               }),
               outcome,
            ],
            maxTokens: envelope.agent.maxTokens ?? undefined,
            temperature: envelope.agent.temperature ?? undefined,
            traceAttributes: { 'berry.run_id': envelope.runId, 'berry.session': envelope.sessionKey },
            messages: warm && held ? held.messages : toConversation(envelope.transcript),
         },
         deps.modelFactory
      );
      if (directory) agent.appState.set(WORKDIR_KEY, directory);

      const result = await agent.invoke(envelope.task.prompt, { cancelSignal: signal });
      await ledger.flush();
      emitUsage(emit, envelope, accounting);
      if (signal.aborted || result.stopReason === 'cancelled') {
         deps.registry.drop(key);
         emit({ type: 'task.failed', failure: { code: 'RUN_CANCELLED', message: 'The session was stopped.', retryable: false } });
         return;
      }
      const fatal = outcome.fatal();
      if (fatal) {
         deps.registry.drop(key);
         emit({ type: 'task.failed', failure: { code: fatal.code, message: fatal.message, retryable: false } });
         return;
      }

      deps.registry.set({ key, fingerprint, messages: agent.messages, workspace, lastUsedAt: Date.now() });
      const [text, cut] = accounting.snapshot().result.final();
      const delivery =
         deps.repository && directory
            ? await deps.repository.deliver({ envelope, session: workspace, directory, summary: text === '' ? null : text, emit })
            : null;
      emit({
         type: 'task.completed',
         result: { text: truncateUtf8(text, MAX_SUMMARY_BYTES), truncated: cut || Buffer.byteLength(text) > MAX_SUMMARY_BYTES, delivery },
      });
   } catch (error) {
      await ledger.flush().catch(() => undefined);
      emitUsage(emit, envelope, accounting);
      // A conversation that ended mid-turn may hold a tool call with no
      // result, which the model refuses on the next invoke. Cold is safe.
      deps.registry.drop(key);
      const failure =
         error instanceof Error && error.name === 'RemoteToolsUnavailable'
            ? { code: 'BERRY_UNREACHABLE', message: error.message, retryable: true }
            : classify(error);
      emit({ type: 'task.failed', failure });
   } finally {
      await Promise.all(mcpClients.map((client) => client.disconnect().catch(() => undefined)));
   }
}

/**
 * The permission table. Fail-closed stays: a name missing from it is refused.
 * Berry's own tools are admitted by name, and Berry enforces their scope. MCP
 * tools are admitted by their prefixed name: a plugin's approved tools, and
 * every tool an admin-configured server listed at load. They go first so an
 * MCP tool can never override a built-in's requirement by sharing its name.
 */
export function toolTable(
   servers: EnvelopeMcpServerLike[],
   listed: Record<string, string[]>,
   remoteNames: string[]
): Record<string, Permission | null> {
   return {
      ...mcpToolPermissions(servers, listed),
      ...TOOL_PERMISSIONS,
      ...Object.fromEntries(remoteNames.map((name) => [name, null])),
   };
}

function emitUsage(emit: Emit, envelope: TaskEnvelope, accounting: AccountingPlugin): void {
   const { usage } = accounting.snapshot();
   if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
   emit({
      type: 'task.usage',
      usage: {
         model: envelope.agent.model,
         inputTokens: usage.inputTokens,
         outputTokens: usage.outputTokens,
         cacheReadTokens: 0,
         cacheWriteTokens: 0,
      },
   });
}

/** What makes a warm conversation the same agent's. */
export function agentFingerprint(envelope: TaskEnvelope): string {
   const { name, instructions, model, permissions, skills, mcpServers } = envelope.agent;
   return createHash('sha256')
      .update(
         JSON.stringify({
            name,
            instructions,
            model,
            permissions: [...permissions].sort(),
            skills: skills.map((skill) => skill.name).sort(),
            mcp: mcpServers.map((server) => server.url).sort(),
         })
      )
      .digest('hex');
}

export { toConversation } from './conversation.ts';
