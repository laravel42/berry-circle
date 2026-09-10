import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Tool } from '@strands-agents/sdk';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { TaskDelivery } from '../../../runtime/lifecycle.ts';
import type { ExecutionSession } from '../../../execution/driver.ts';
import { runCommandTool, WORKDIR_KEY } from '../../command-tool.ts';
import { permissionsOf } from '../../permissions.ts';
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
import {
   RemoteToolsUnavailable,
   collectFileTool,
   loadRemoteTools,
   type BerryApi,
} from './remote-tools.ts';
import type { SessionRegistry } from './sessions.ts';

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
   /** Where session workspaces live: `/mnt/workspace` in the image. */
   workRoot: string;
   fetch?: typeof fetch;
   loadTools?: (api: BerryApi) => Promise<Tool[]>;
   repository?: RepositoryStep;
}

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

   try {
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
      ];
      // Fail-closed stays: a name missing from the table is refused. Berry's
      // own tools are admitted by name, and Berry enforces their scope.
      const table = { ...TOOL_PERMISSIONS, ...Object.fromEntries(remote.map((t) => [t.name, null])) };

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
            tools,
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
   }
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
