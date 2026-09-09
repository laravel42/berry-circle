import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import type { Storage } from '../storage/storage.ts';
import { RunLedger, RunTerminal, type Dispatch, type Run, type Usage } from '../runs/ledger.ts';
import { postRunResult, truncateUtf8 } from '../runs/result-comment.ts';
import { BerryArtifactService } from './artifact-service.ts';
import { berryTools } from './tools.ts';
import type { ExecutionDriver, ExecutionSession } from '../execution/driver.ts';
import { permissionsOf, type PermissionSet } from './permissions.ts';
import { nullRunMemory, recallPrompt, type RunMemory } from '../agentcore/memory.ts';
import type { ConnectionRepository } from '../integrations/connections.ts';
import type { GitHubAppRepository } from '../integrations/github-app.ts';
import { GitHubClient } from '../integrations/github.ts';
import {
   deliverRepository,
   prepareRepository,
   type PreparedRepository,
   type RepositoryRunDeps,
} from './repository-run.ts';
import { buildMessage, lastRejection } from './prompt.ts';
import { MAX_SUMMARY_BYTES, type ResultText } from './runtime/result-text.ts';
import { classify } from './runtime/failure.ts';
import { buildRunAgent } from './runtime/agent.ts';
import { bedrockModel, type AwsCredentials, type ModelFactory } from './runtime/model.ts';
import { LedgerPlugin } from './runtime/plugins/ledger.ts';
import { AccountingPlugin } from './runtime/plugins/accounting.ts';
import { PermissionPlugin } from './runtime/plugins/permissions.ts';
import { ToolFailed, ToolOutcomePlugin } from './runtime/plugins/tool-outcome.ts';
import { WORKDIR_KEY } from './command-tool.ts';

/**
 * Runs one Berry run on the Strands agent loop, writing the ledger Berry
 * already keeps.
 *
 * The ledger does not change — the same `run_events`, the same statuses, the
 * same result comment on the task — because those are product surfaces read
 * by the run stream, the task timeline and the peer reviewer. What produces
 * them is a set of plugins on the SDK's own lifecycle: the ledger plugin
 * writes tool and output rows from hooks, accounting sums usage and tracks
 * the result, the permission plugin refuses what the agent may not do, and
 * the tool-outcome plugin decides what a thrown tool costs. This file no
 * longer reads a single event; it builds the agent, invokes it once, and
 * records how it ended.
 *
 * One failure from a much earlier runtime is worth keeping in view, because
 * it shaped the result handling that survives here. It emitted `done` at the
 * end of every model turn and kept going, so treating the first `done` as the
 * end recorded runs as succeeded seconds in — with "I'll look into this"
 * posted as the result. The lesson is kept in two places: a run is recorded
 * as succeeded only when `invoke()` returns, and the result is the last
 * substantive turn rather than the last thing said.
 */

export interface ExecutorOptions {
   sql: Sql;
   storage: Storage;
   ledger?: RunLedger;
   /** The AWS region Bedrock is called in. */
   region: string;
   /**
    * Explicit Bedrock credentials. Omitted means the AWS default chain, which
    * is wrong wherever `AWS_ACCESS_KEY_ID` belongs to something else — in the
    * Compose stack it is MinIO's, and Bedrock rejects it as an invalid
    * security token.
    */
   credentials?: AwsCredentials | null;
   /** Used when the agent row names no model of its own. */
   defaultModel?: string;
   clock?: () => Date;
   newId?: () => string;
   /**
    * Where an agent's commands run. Omitted means the agent has no
    * `run_command` tool — a deployment without a substrate does not offer a
    * capability it cannot deliver.
    */
   execution?: ExecutionDriver;
   /**
    * Where a provider credential comes from. Omitted means a run never gets a
    * repository, even when its project names one — because a checkout without
    * a credential is a clone that fails, not a run that works.
    */
   connections?: ConnectionRepository;
   /** Preferred over `connections` for repository work when a App exists. */
   githubApp?: GitHubAppRepository;
   /** Injected in tests. Defaults to the real GitHub API. */
   github?: (token: string) => GitHubClient;
   /** The credential a run clones and pushes with, from AgentCore Identity. */
   gitCredential?:
      | ((workspaceId: string) => Promise<{ username: string; password: string; canPush?: boolean }>)
      | undefined;
   /**
    * What earlier runs on the issue did. Omitted means no recall, which is the
    * behaviour every run had before Memory was wired.
    */
   memory?: RunMemory;
   /** Builds the model for a run. Tests pass a scripted one. */
   modelFactory?: ModelFactory;
   /**
    * The peer review gate, when the deployment has one. Asked after a run
    * succeeds; it decides for itself whether the task opted in.
    */
   reviewGate?: { review(runId: string): Promise<unknown> };
   /** Where a gate failure is reported. It never fails the run. */
   onGateError?: (error: unknown) => void;
   /** A ceiling on one model reply. Omitted means the factory's default. */
   maxTokens?: number;
   temperature?: number;
}

export interface RunOutcome {
   runId: string;
   status: 'succeeded' | 'failed' | 'cancelled';
   summary: string | null;
   usage: Usage;
   toolCalls: number;
   failure?: { code: string; message: string; retryable: boolean };
}

/** The lazily-opened workspace, as `lazyWorkspace` returns it. */
interface Workspace {
   open: () => Promise<ExecutionSession>;
   close: () => Promise<void>;
}

/** A run that failed before it could spend anything. */
function usageZero(): Usage {
   return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null };
}

interface AgentRow {
   id: string;
   name: string;
   instructions: string | null;
   model: string;
   permissions: PermissionSet;
}

export class RunExecutor {
   private readonly sql: Sql;
   private readonly storage: Storage;
   /**
    * Where an agent's commands run. Absent means the agent has no
    * `run_command` tool at all — see the note on `ToolScope.commands`.
    */
   private readonly execution: ExecutionDriver | undefined;
   private readonly connections: ConnectionRepository | undefined;
   private readonly githubApp: GitHubAppRepository | undefined;
   /** The AWS region Bedrock is called in. */
   private readonly region: string;
   private readonly credentials: AwsCredentials | null;
   private readonly github: (token: string) => GitHubClient;
   private readonly gitCredential:
      | ((workspaceId: string) => Promise<{ username: string; password: string; canPush?: boolean }>)
      | undefined;
   private readonly ledger: RunLedger;
   private readonly defaultModel: string;
   private readonly clock: () => Date;
   private readonly newId: () => string;
   /** Never null, so the recall path has no branch in it. */
   private readonly memory: RunMemory;
   private readonly modelFactory: ModelFactory;
   private readonly reviewGate: { review(runId: string): Promise<unknown> } | undefined;
   private readonly onGateError: (error: unknown) => void;
   private readonly maxTokens: number | undefined;
   private readonly temperature: number | undefined;

   constructor(options: ExecutorOptions) {
      this.sql = options.sql;
      this.storage = options.storage;
      this.ledger =
         options.ledger ??
         new RunLedger({
            sql: options.sql,
            ...(options.clock ? { clock: options.clock } : {}),
            ...(options.newId ? { newId: options.newId } : {}),
         });
      this.execution = options.execution;
      this.connections = options.connections;
      this.githubApp = options.githubApp;
      this.region = options.region;
      this.credentials = options.credentials ?? null;
      this.github = options.github ?? ((token) => new GitHubClient({ token }));
      this.gitCredential = options.gitCredential;
      // A Bedrock inference profile id. The previous default here was
      // `anthropic/claude-sonnet-4.5`, an OpenRouter-style name that Bedrock
      // cannot serve — the exact vocabulary migration 047 existed to rewrite,
      // left behind in the one place a migration could not reach. Production
      // always passes `config.agents.defaultModel`, so this was reachable only
      // by a caller that omitted it, which is why it stayed wrong quietly.
      this.defaultModel = options.defaultModel ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
      this.clock = options.clock ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
      this.memory = options.memory ?? nullRunMemory();
      this.modelFactory = options.modelFactory ?? bedrockModel;
      this.reviewGate = options.reviewGate;
      this.onGateError = options.onGateError ?? (() => {});
      this.maxTokens = options.maxTokens;
      this.temperature = options.temperature;
   }

   /**
    * Claims a queued run and executes it to completion.
    *
    * `signal` is how cancellation reaches a model call already in flight: the
    * caller aborts, the run is recorded cancelled, and the provider request is
    * dropped rather than paid for to the end.
    */
   async execute(runId: string, signal?: AbortSignal): Promise<RunOutcome> {
      const dispatch = await this.ledger.claimDispatch(runId);

      let agent: AgentRow;
      try {
         agent = await this.loadAgent(dispatch.agentId);
      } catch (error) {
         // A run that cannot name its agent has not started, so it fails
         // rather than reconciles: nothing was dispatched anywhere.
         await this.ledger.fail({
            runId,
            failure: {
               code: 'AGENT_UNAVAILABLE',
               message: String((error as Error)?.message ?? error),
               retryable: false,
            },
         });
         throw error;
      }

      return this.run(dispatch, agent, signal);
   }

   private async run(
      dispatch: Dispatch,
      agent: AgentRow,
      signal: AbortSignal | undefined
   ): Promise<RunOutcome> {
      const artifacts = new BerryArtifactService({
         sql: this.sql,
         storage: this.storage,
         workspaceId: dispatch.workspaceId,
         runId: dispatch.runId,
         issueId: dispatch.issueId,
         agentId: agent.id,
         agentName: agent.name,
         clock: this.clock,
         newId: this.newId,
      });
      // Opened on the first command and not before: most runs never call one,
      // and a container started for every run would pay that cost for nothing.
      const workspace = this.execution ? lazyWorkspace(this.execution, dispatch.runId) : null;

      // No session service: Strands holds the conversation in the agent for
      // the life of the call, and Berry's durable record of what happened has
      // always been the run ledger rather than a second copy.
      const tools = berryTools({
         sql: this.sql,
         artifacts,
         workspaceId: dispatch.workspaceId,
         issueId: dispatch.issueId,
         ...(workspace
            ? {
                 commands: {
                    ledger: this.ledger,
                    runId: dispatch.runId,
                    session: workspace.open,
                    newId: this.newId,
                    clock: this.clock,
                 },
              }
            : {}),
      });

      // Both read before the run is marked running, so a reviewer's feedback
      // and the agent's own earlier attempts are part of the first message
      // rather than something it learns late. Concurrent because neither needs
      // the other, and both sit in front of a run that has not started yet.
      const [reviewFeedback, recalled] = await Promise.all([
         lastRejection(this.sql, dispatch.issueId),
         this.memory.recall({ agentId: dispatch.agentId, issueId: dispatch.issueId }),
      ]);
      const priorWork = recallPrompt(recalled);

      const ledger = new LedgerPlugin({ ledger: this.ledger, runId: dispatch.runId });
      const accounting = new AccountingPlugin();
      const outcome = new ToolOutcomePlugin();

      // The outer try exists only for the finally: the workspace is torn down
      // whatever happens, and the inner try decides what "whatever" means.
      try {
         try {
            // Inside the try: a cancel landing between the claim and here must
            // return an outcome rather than throw out of execute().
            await this.ledger.markRunning(dispatch.runId);

            // The repository, if the task's project names one. Done after the
            // run is running so a clone that takes a minute is visible as a run
            // in progress rather than as one that has not started.
            let prepared: PreparedRepository | null;
            try {
               prepared = await prepareRepository(this.repositoryDeps(), {
                  dispatch,
                  agentName: agent.name,
                  permissions: agent.permissions,
                  session: workspace ? workspace.open : null,
               });
            } catch (error) {
               // A run that cannot get its repository has not begun its work,
               // and letting the agent loose in an empty workspace would
               // produce a confident answer about code it never saw.
               return await this.fail(dispatch, error, usageZero(), 0);
            }

            const runAgent = buildRunAgent(
               {
                  agentName: agent.name,
                  model: agent.model,
                  region: this.region,
                  credentials: this.credentials,
                  systemPrompt: agent.instructions?.trim() || defaultInstructions(agent.name),
                  tools,
                  plugins: [
                     ledger,
                     accounting,
                     // Checked inside every call, so a revoked permission
                     // refuses rather than merely hiding the affordance.
                     new PermissionPlugin({ permissions: agent.permissions }),
                     outcome,
                  ],
                  maxTokens: this.maxTokens,
                  temperature: this.temperature,
                  traceAttributes: {
                     'berry.run_id': dispatch.runId,
                     'berry.issue_id': dispatch.issueId,
                     'berry.workspace_id': dispatch.workspaceId,
                     'berry.agent_id': dispatch.agentId,
                  },
               },
               this.modelFactory
            );
            // Read by the command tool at call time, so the agent's commands
            // land in the checkout rather than at the workspace root.
            if (prepared) runAgent.appState.set(WORKDIR_KEY, prepared.checkout.directory);

            const result = await runAgent.invoke(
               buildMessage({
                  ...dispatch,
                  reviewFeedback,
                  ...(priorWork ? { priorWork } : {}),
               }),
               signal ? { cancelSignal: signal } : {}
            );
            // The SDK reports an aborted loop as a stop reason rather than by
            // raising, so a run cancelled mid-turn arrives here looking
            // finished. Reporting success would contradict a ledger that
            // already says cancelled.
            if (signal?.aborted || result.stopReason === 'cancelled') throw new RunCancelled();

            // A tool whose failure means durable state was silently lost ends
            // the run as failed rather than as a confident success.
            const fatal = outcome.fatal();
            if (fatal) throw fatal;

            // Inside the try, because the workspace is torn down in the
            // finally and the push needs it still standing.
            if (prepared && workspace) {
               const [delivered] = accounting.snapshot().result.final();
               await deliverRepository(this.repositoryDeps(), {
                  dispatch,
                  prepared,
                  // The same workspace the checkout went into — a new session
                  // would be an empty container with nothing to push.
                  session: await workspace.open(),
                  summary: delivered === '' ? null : delivered,
                  artifacts: {
                     paths: () => artifacts.listArtifactKeys(),
                     read: async (path) => {
                        const part = await artifacts.loadArtifact({ filename: path });
                        return part?.inlineData?.data
                           ? Buffer.from(part.inlineData.data, 'base64')
                           : null;
                     },
                  },
               });
            }
         } catch (error) {
            // Whatever was gathered is part of the record even when the run
            // ends badly: it is what the agent had said before it stopped.
            await ledger.flush().catch(() => undefined);
            const { usage, toolCalls } = accounting.snapshot();
            if (error instanceof RunCancelled || signal?.aborted) {
               // Awaited inside the try so the workspace is not torn down
               // while the run is still being recorded.
               return await this.cancel(dispatch, usage, toolCalls);
            }
            // An undelivered run is not done: a run that reports success with
            // nothing pushed sends a reviewer looking for a pull request that
            // was never opened.
            return await this.fail(dispatch, error, usage, toolCalls);
         }

         // Outside the catch on purpose: a failure while *recording* success is
         // not a failed run.
         const { usage, toolCalls, result } = accounting.snapshot();
         return await this.succeed(dispatch, result, usage, toolCalls);
      } finally {
         // Whether the run succeeded, failed or was cancelled: "the workspace
         // is destroyed when the run ends" has no exceptions, and a container
         // left behind is one nothing will ever collect. It runs after the
         // delivery above, which needs the workspace still standing.
         if (workspace) await workspace.close();
      }
   }

   /** The collaborators the repository half needs, in one place. */
   private repositoryDeps(): RepositoryRunDeps {
      return {
         sql: this.sql,
         ledger: this.ledger,
         connections: this.connections,
         githubApp: this.githubApp,
         github: this.github,
         gitCredential: this.gitCredential,
      };
   }

   private async succeed(
      dispatch: Dispatch,
      result: ResultText,
      usage: Usage,
      toolCalls: number
   ): Promise<RunOutcome> {
      const [text, cut] = result.final();
      const summary = text === '' ? null : truncateUtf8(text, MAX_SUMMARY_BYTES);

      let run: Run;
      try {
         run = await this.ledger.completeSuccess({ runId: dispatch.runId, summary, usage });
      } catch (cause) {
         if (!(cause instanceof RunTerminal)) throw cause;
         // Swept or cancelled while completing. The work is in the ledger and
         // the row already says how it ended; that verdict stands. What was
         // paid for is returned rather than discarded.
         return { runId: dispatch.runId, status: 'cancelled', summary, usage, toolCalls };
      }

      // The summary rather than the whole transcript: the ledger already holds
      // every command, and what the next run needs is the conclusion, not the
      // work. Recorded after the ledger, because the ledger is the durable
      // record and memory is the convenience built on top of it.
      if (summary) {
         await this.memory.record({
            agentId: dispatch.agentId,
            issueId: dispatch.issueId,
            role: 'ASSISTANT',
            text: summary,
            runId: dispatch.runId,
         });
      }
      if (text !== '') {
         // Best effort by design: the run succeeded and its ledger says so. A
         // comment that fails to post is worth a retry, not a failed run.
         await postRunResult(this.sql, {
            issueId: dispatch.issueId,
            agentId: dispatch.agentId,
            text,
            cut,
            occurredAt: this.clock().toISOString(),
            newId: this.newId,
         }).catch(() => null);
      }
      // After the run is recorded: the gate reads the ledger, and a review
      // that fails is a fact about the review, never about the run.
      if (this.reviewGate) {
         await this.reviewGate.review(dispatch.runId).catch((error: unknown) => this.onGateError(error));
      }
      return {
         runId: dispatch.runId,
         status: 'succeeded',
         summary: run.summary,
         usage,
         toolCalls,
      };
   }

   private async fail(
      dispatch: Dispatch,
      error: unknown,
      usage: Usage,
      toolCalls: number
   ): Promise<RunOutcome> {
      const failure =
         error instanceof ToolFailed
            ? { code: error.code, message: error.message, retryable: false }
            : classify(error);
      // A run already made terminal elsewhere — cancelled while this loop was
      // unwinding — must not be overwritten with a failure caused by that
      // cancellation.
      await this.ledger.fail({ runId: dispatch.runId, failure }).catch((cause) => {
         if (!(cause instanceof RunTerminal)) throw cause;
      });

      // A failure is the most valuable thing to recall: it is the one outcome
      // the next run should not reproduce, and unlike a rejected review it is
      // recorded even when the run never produced a result to review.
      await this.memory.record({
         agentId: dispatch.agentId,
         issueId: dispatch.issueId,
         role: 'ASSISTANT',
         text: `An earlier run failed with ${failure.code}: ${failure.message}`,
         runId: dispatch.runId,
      });
      return { runId: dispatch.runId, status: 'failed', summary: null, usage, toolCalls, failure };
   }

   private async cancel(
      dispatch: Dispatch,
      usage: Usage,
      toolCalls: number
   ): Promise<RunOutcome> {
      await this.ledger.markCancelled(dispatch.runId).catch((cause) => {
         if (!(cause instanceof RunTerminal)) throw cause;
      });
      return { runId: dispatch.runId, status: 'cancelled', summary: null, usage, toolCalls };
   }

   private async loadAgent(agentId: string): Promise<AgentRow> {
      const [row] = await this.sql`
         SELECT id, name, instructions, model_name, permissions
           FROM agents
          WHERE id = ${agentId} AND archived_at IS NULL`;
      if (!row) throw new Error(`agent ${agentId} does not exist`);
      return {
         id: row.id as string,
         name: row.name as string,
         instructions: (row.instructions as string | null) ?? null,
         // An agent with no model of its own runs on the deployment's default
         // rather than not at all.
         model: (row.model_name as string | null) || this.defaultModel,
         permissions: permissionsOf(row.permissions as string[] | null, row.name as string),
      };
   }
}

class RunCancelled extends Error {
   constructor() {
      super('run cancelled');
      this.name = 'RunCancelled';
   }
}

/** What an agent with no instructions of its own is told it is. */
function defaultInstructions(name: string): string {
   return `You are ${name}, an agent working a task in Berry. Do the task you are given and report what you did.`;
}

/**
 * A workspace that is created once, on demand, and torn down once.
 *
 * `close` never throws. It runs on the success path too, and a substrate that
 * failed to tidy up must not turn a finished run into a failed one — the
 * container is leaked either way, and losing the run's result as well helps
 * nobody.
 */
function lazyWorkspace(
   driver: ExecutionDriver,
   runId: string
): { open: () => Promise<ExecutionSession>; close: () => Promise<void> } {
   let opening: Promise<ExecutionSession> | null = null;

   return {
      open: () => {
         // Memoised on the promise so two racing tool calls share one
         // workspace — and cleared on rejection, so one transient failure does
         // not answer every later call with the same stale error.
         opening ??= driver.createSession({ runId }).catch((error: unknown) => {
            opening = null;
            throw error;
         });
         return opening;
      },
      close: async () => {
         if (!opening) return;
         await opening.then((session) => session.destroy()).catch(() => undefined);
      },
   };
}
