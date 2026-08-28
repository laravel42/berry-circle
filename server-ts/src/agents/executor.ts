import { randomUUID } from 'node:crypto';
import { LlmAgent, Runner, StreamingMode, isFinalResponse } from '@google/adk';
import type { Event } from '@google/adk';
import type { Sql } from '../db/pool.ts';
import type { Storage } from '../storage/storage.ts';
import { RunLedger, RunTerminal, type Dispatch, type Usage } from '../runs/ledger.ts';
import { postRunResult, truncateUtf8 } from '../runs/result-comment.ts';
import { BerryArtifactService } from './artifact-service.ts';
import { BerrySessionService } from './session-service.ts';
import { OpenRouterLlm } from './openrouter-llm.ts';
import { berryTools } from './tools.ts';
import type { ExecutionDriver, ExecutionSession } from '../execution/driver.ts';
import type { ConnectionRepository } from '../integrations/connections.ts';
import { GitHubClient } from '../integrations/github.ts';
import {
   deliverRepository,
   prepareRepository,
   type PreparedRepository,
   type RepositoryRunDeps,
} from './repository-run.ts';
import { buildMessage, lastRejection } from './prompt.ts';

/**
 * Runs one Berry run through ADK, writing the ledger Berry already keeps.
 *
 * This is what replaces Berry's consumption of a separate runtime's event
 * stream. The ledger does not change — the same `run_events`, the
 * same statuses, the same result comment on the task — because those are
 * product surfaces read by the run stream, the task timeline and the peer
 * reviewer. What changes is who produces them, and that the agent now has
 * tools that reach Berry itself.
 *
 * One failure from the previous runtime is worth keeping in view, because it
 * shaped this loop. It emitted `done` at the end of every model turn and
 * kept the connection open when the agent had called a tool, so treating the
 * first `done` as the end recorded runs as succeeded seconds in — with "I'll
 * look into this" posted as the result — while the agent worked on for minutes
 * into a stream nobody read. ADK has no such ambiguity: the event iterator
 * ends when the agent is done. The lesson survives anyway in two places: a run
 * is recorded as succeeded only when the iterator actually completes, and the
 * result is the last substantive turn rather than the last thing said.
 */

const MAX_SUMMARY_BYTES = 5_000;

/**
 * Separates an answer from a remark.
 *
 * A report is hundreds of bytes at the least; a sign-off ("I'll write that to
 * a file") is not. Recording the closing line as the result lost the answer it
 * followed, often enough that the distinction is worth this constant.
 */
const SUBSTANTIVE_RESULT_BYTES = 400;

/**
 * How much streamed text is gathered before it becomes one ledger event.
 *
 * The previous runtime emitted whole sentences and Berry wrote one event per
 * chunk; OpenRouter emits tokens, and one transaction per token would mean thousands
 * of row-locked writes for one answer and a `run_events` table that is mostly
 * single words. Gathering to roughly a sentence keeps the stream live without
 * making the ledger a token log.
 *
 * The cap is the long-standing ceiling on a single published delta.
 */
const OUTPUT_FLUSH_BYTES = 240;
const OUTPUT_FLUSH_MS = 250;
const MAX_DELTA_BYTES = 16 * 1024;

export interface ExecutorOptions {
   sql: Sql;
   storage: Storage;
   ledger?: RunLedger;
   apiKey: string;
   baseUrl?: string | undefined;
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
   /** Injected in tests. Defaults to the real GitHub API. */
   github?: (token: string) => GitHubClient;
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
}

export class AdkExecutor {
   private readonly sql: Sql;
   private readonly storage: Storage;
   /**
    * Where an agent's commands run. Absent means the agent has no
    * `run_command` tool at all — see the note on `ToolScope.commands`.
    */
   private readonly execution: ExecutionDriver | undefined;
   private readonly connections: ConnectionRepository | undefined;
   private readonly github: (token: string) => GitHubClient;
   private readonly ledger: RunLedger;
   private readonly apiKey: string;
   private readonly baseUrl: string | undefined;
   private readonly defaultModel: string;
   private readonly clock: () => Date;
   private readonly newId: () => string;

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
      this.github = options.github ?? ((token) => new GitHubClient({ token }));
      this.apiKey = options.apiKey;
      this.baseUrl = options.baseUrl;
      this.defaultModel = options.defaultModel ?? 'anthropic/claude-sonnet-4.5';
      this.clock = options.clock ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
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

      // Set once the repository is in place, and read by the command tool when
      // the agent runs something — so its commands land in the checkout rather
      // than at the workspace root.
      let workdir: string | undefined;

      const sessions = new BerrySessionService({
         sql: this.sql,
         workspaceId: dispatch.workspaceId,
         runId: dispatch.runId,
         clock: this.clock,
         newId: this.newId,
      });

      const runner = new Runner({
         appName: 'berry',
         agent: new LlmAgent({
            name: toAgentName(agent.name),
            model: new OpenRouterLlm({
               model: agent.model,
               apiKey: this.apiKey,
               ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
               title: 'Berry',
            }),
            instruction: agent.instructions ?? '',
            tools: berryTools({
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
                          // Read at call time, not at construction: the
                          // checkout happens after the tools are built.
                          workdirAt: () => workdir,
                       },
                    }
                  : {}),
            }),
         }),
         sessionService: sessions,
         artifactService: artifacts,
      });

      // Read before the run is marked running, so a reviewer's feedback is
      // part of the first message rather than something the agent learns late.
      const reviewFeedback = await lastRejection(this.sql, dispatch.issueId);

      await this.ledger.markRunning(dispatch.runId);

      // The repository, if the task's project names one. Done after the run is
      // running so a clone that takes a minute is visible as a run in progress
      // rather than as one that has not started.
      let prepared: PreparedRepository | null = null;
      try {
         prepared = await prepareRepository(this.repositoryDeps(), {
            dispatch,
            agentName: agent.name,
            session: workspace ? workspace.open : null,
         });
      } catch (error) {
         // A run that cannot get its repository has not begun its work, and
         // letting the agent loose in an empty workspace would produce a
         // confident answer about code it never saw.
         return await this.fail(dispatch, error, usageZero(), 0);
      }
      if (prepared) workdir = prepared.checkout.directory;
      const session = await sessions.createSession({
         appName: 'berry',
         userId: `run:${dispatch.runId}`,
         // The run's own id, so the transcript is findable from the run and
         // removed with it.
         sessionId: dispatch.runId,
      });

      const usage: Usage = {
         inputTokens: 0,
         outputTokens: 0,
         totalTokens: 0,
         costMicros: null,
         currency: null,
      };
      const result = new ResultText();

      // The outer try exists only for the finally: the workspace is torn down
      // whatever happens, and the inner try decides what "whatever" means.
      try {
         const openTools = new Map<string, string>();
         const output = new OutputBuffer((text) =>
            this.ledger.appendOutput(dispatch.runId, 'progress', text)
         );
         let toolCalls = 0;
         // Whether this turn arrived as deltas. When it did, the aggregated event
         // that closes the turn repeats every one of them, and recording its text
         // too would double the run's output and its report.
         let streamed = false;

         try {
            for await (const event of runner.runAsync({
               userId: session.userId,
               sessionId: session.id,
               newMessage: {
                  role: 'user',
                  parts: [{ text: buildMessage({ ...dispatch, reviewFeedback }) }],
               },
               // Token by token, as Berry's run stream has always shown it. A run
               // that only appears when it is over is a run people assume hung.
               runConfig: { streamingMode: StreamingMode.SSE },
               ...(signal ? { abortSignal: signal } : {}),
            })) {
               if (signal?.aborted) throw new RunCancelled();
               const skipText = streamed && event.partial !== true;
               toolCalls += await this.recordEvent(
                  dispatch.runId,
                  event,
                  result,
                  openTools,
                  output,
                  skipText
               );
               if (event.partial === true) streamed = true;
               addUsage(usage, event);
               // ADK marks the end of a turn; the result accumulator needs it to
               // tell a report from the progress that preceded it.
               if (isTurnComplete(event)) {
                  // Flushed at the boundary so the ledger never shows a turn
                  // ending before the text that ended it.
                  await output.flush();
                  result.endTurn();
                  streamed = false;
               }
            }

            await output.flush();
            result.endTurn();
            // Every tool the agent left open failed by omission: the iterator
            // ended without a response for it. Recording nothing would leave the
            // run stream showing a tool that never stops running.
            await this.closeOpenTools(dispatch.runId, openTools);

            // Inside the try, because the workspace is torn down in the finally
            // and the push needs it still standing.
            const repository = prepared;
            if (repository) {
               const [delivered] = result.final();
               try {
                  await deliverRepository(this.repositoryDeps(), {
                     dispatch,
                     prepared: repository,
                     // The same workspace the checkout went into — a new
                     // session would be an empty container with nothing to
                     // push.
                     session: await workspace!.open(),
                     summary: delivered === '' ? null : delivered,
                  });
               } catch (error) {
                  // The agent's work is in the ledger either way, but a run that
                  // reports success with nothing pushed sends a reviewer looking
                  // for a pull request that was never opened. Undelivered is not
                  // done.
                  return await this.fail(dispatch, error, usage, toolCalls);
               }
            }
         } catch (error) {
            // Whatever was gathered is part of the record even when the run ends
            // badly: it is what the agent had said before it stopped.
            await output.flush().catch(() => undefined);
            result.endTurn();
            if (error instanceof RunCancelled || signal?.aborted) {
               // Awaited inside the try so the workspace is not torn down while
               // the run is still being recorded.
               return await this.cancel(dispatch, usage, toolCalls);
            }
            return await this.fail(dispatch, error, usage, toolCalls);
         }

         // Outside the catch on purpose: a failure while *recording* success is
         // not a failed run, and calling fail() on a run the ledger has already
         // completed would refuse anyway.
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
         github: this.github,
      };
   }

   /**
    * One ADK event as ledger rows.
    *
    * A tool call and its result are two events here as they are in Berry: the
    * pair is what lets a run stream show a tool as running rather than only as
    * having run. Neither carries arguments or output — the ledger is public to
    * everyone who can see the task, and a tool's input is not.
    */
   private async recordEvent(
      runId: string,
      event: Event,
      result: ResultText,
      openTools: Map<string, string>,
      output: OutputBuffer,
      skipText: boolean
   ): Promise<number> {
      let toolCalls = 0;

      for (const part of event.content?.parts ?? []) {
         if (part.functionCall) {
            // Before the tool event, so the ledger reads in the order things
            // happened: the agent said something, then called something.
            await output.flush();
            const callId = part.functionCall.id ?? `tool_${openTools.size + 1}`;
            openTools.set(callId, part.functionCall.name ?? '');
            toolCalls += 1;
            await this.ledger.appendToolStarted(runId, callId, part.functionCall.name ?? '');
            continue;
         }
         if (part.functionResponse) {
            const callId = part.functionResponse.id ?? '';
            openTools.delete(callId);
            await this.ledger.appendToolCompleted(
               runId,
               callId,
               !isToolError(part.functionResponse.response)
            );
            continue;
         }
         // A thought is the model reasoning, not the agent's answer. Recording
         // it as output would put it in the comment the task receives.
         if (!skipText && typeof part.text === 'string' && part.text !== '' && !part.thought) {
            // The result keeps every character; the ledger gets them gathered.
            result.append(part.text);
            await output.add(part.text);
         }
      }
      return toolCalls;
   }

   private async closeOpenTools(runId: string, openTools: Map<string, string>): Promise<void> {
      for (const callId of openTools.keys()) {
         await this.ledger.appendToolCompleted(runId, callId, false).catch(() => undefined);
      }
      openTools.clear();
   }

   private async succeed(
      dispatch: Dispatch,
      result: ResultText,
      usage: Usage,
      toolCalls: number
   ): Promise<RunOutcome> {
      const [text, cut] = result.final();
      const summary = text === '' ? null : truncateUtf8(text, MAX_SUMMARY_BYTES);

      const run = await this.ledger.completeSuccess({
         runId: dispatch.runId,
         summary,
         usage,
      });
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
      const failure = {
         code: failureCode(error),
         message: truncateUtf8(String((error as Error)?.message ?? error), 2_000),
         retryable: isRetryable(error),
      };
      // A run already made terminal elsewhere — cancelled while this loop was
      // unwinding — must not be overwritten with a failure caused by that
      // cancellation.
      await this.ledger.fail({ runId: dispatch.runId, failure }).catch((cause) => {
         if (!(cause instanceof RunTerminal)) throw cause;
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
         SELECT id, name, instructions, model_name
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
      };
   }
}

class RunCancelled extends Error {
   constructor() {
      super('run cancelled');
      this.name = 'RunCancelled';
   }
}

/**
 * Gathers streamed text into ledger-sized deltas.
 *
 * Time as well as size, because size alone stalls: an agent that stops
 * mid-sentence to think would leave its last words unwritten until it resumed,
 * and a reader watching the run would see it freeze. Whichever comes first
 * wins.
 */
class OutputBuffer {
   private readonly write: (text: string) => Promise<void>;
   private pending = '';
   private since = 0;

   constructor(write: (text: string) => Promise<void>) {
      this.write = write;
   }

   async add(text: string): Promise<void> {
      if (this.pending === '') this.since = Date.now();
      this.pending += text;
      const size = Buffer.byteLength(this.pending, 'utf8');
      if (size >= OUTPUT_FLUSH_BYTES || Date.now() - this.since >= OUTPUT_FLUSH_MS) {
         await this.flush();
      }
   }

   async flush(): Promise<void> {
      if (this.pending === '') return;
      const text = this.pending;
      this.pending = '';
      // Split rather than truncated: a delta over the cap is still the
      // agent's words, and dropping the tail would lose them from the stream
      // while the summary still had them.
      for (const piece of splitUtf8(text, MAX_DELTA_BYTES)) await this.write(piece);
   }
}

/**
 * Cuts text into pieces of at most `maxBytes`, never mid-character.
 *
 * Ported from runadmission's splitUTF8, and for the same reason: a delta cut
 * mid-sequence reaches the browser as a replacement character in the middle of
 * a word.
 */
export function splitUtf8(value: string, maxBytes: number): string[] {
   if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value === '' ? [] : [value];

   const pieces: string[] = [];
   let piece = '';
   let size = 0;
   for (const character of value) {
      const width = Buffer.byteLength(character, 'utf8');
      if (size + width > maxBytes) {
         pieces.push(piece);
         piece = '';
         size = 0;
      }
      piece += character;
      size += width;
   }
   if (piece !== '') pieces.push(piece);
   return pieces;
}

/**
 * The agent's final message, tracked across turns.
 *
 * Each turn's text is kept apart because the final message is what the agent
 * reports with: earlier turns ("I'll look into this") are progress. A turn
 * that says nothing, such as a bare tool call, leaves the result as it was.
 *
 * Ported from runadmission's resultText, including the distinction between the
 * last turn that said anything and the last that said enough to be a report.
 */
export class ResultText {
   private turn = '';
   private last = '';
   private substantive = '';
   private lastCut = false;
   private subCut = false;

   append(value: string): void {
      this.turn += value;
   }

   endTurn(): void {
      const text = this.turn.trim();
      if (text !== '') {
         const cut = Buffer.byteLength(text, 'utf8') > MAX_SUMMARY_BYTES;
         this.last = text;
         this.lastCut = cut;
         if (Buffer.byteLength(text, 'utf8') >= SUBSTANTIVE_RESULT_BYTES) {
            this.substantive = text;
            this.subCut = cut;
         }
      }
      this.turn = '';
   }

   /**
    * The result and whether it was cut: the last substantive turn, or the last
    * turn that said anything when nothing was substantive.
    */
   final(): [string, boolean] {
      if (this.substantive !== '') return [this.substantive, this.subCut];
      return [this.last, this.lastCut];
   }
}

/**
 * Whether this event closes a turn.
 *
 * ADK marks it two ways depending on whether the model streamed, so both are
 * checked: missing a turn boundary would merge a tool-call turn into the
 * answer that followed and make every run's result look substantive.
 */
function isTurnComplete(event: Event): boolean {
   if (event.turnComplete === true) return true;
   if (event.partial === true) return false;
   return isFinalResponse(event);
}

/**
 * A tool response that reports an error.
 *
 * ADK puts a thrown tool error in the response body rather than failing the
 * run, so the ledger only learns the tool failed by looking.
 */
function isToolError(response: unknown): boolean {
   if (!response || typeof response !== 'object') return false;
   return 'error' in (response as Record<string, unknown>);
}

function addUsage(usage: Usage, event: Event): void {
   const metadata = event.usageMetadata;
   if (!metadata) return;
   // Summed across turns: an agent that called three tools made four model
   // calls, and the run cost all of them.
   usage.inputTokens += metadata.promptTokenCount ?? 0;
   // Reasoning tokens are not added separately: OpenRouter reports them inside
   // completion_tokens, which is what candidatesTokenCount carries.
   usage.outputTokens += metadata.candidatesTokenCount ?? 0;
   usage.totalTokens = usage.inputTokens + usage.outputTokens;
}

/**
 * ADK requires an identifier-shaped agent name.
 *
 * Berry's names are free text — "Prototype Writer" — so they are normalised
 * rather than rejected: the name is a label the model sees, and refusing to
 * run an agent because its name has a space in it would be absurd.
 */
export function toAgentName(name: string): string {
   const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
   return normalized === '' ? 'agent' : normalized;
}

function failureCode(error: unknown): string {
   const status = (error as { status?: number })?.status;
   if (status === 429) return 'RATE_LIMITED';
   if (typeof status === 'number' && status >= 500) return 'UPSTREAM_UNAVAILABLE';
   if (typeof status === 'number') return 'UPSTREAM_REJECTED';
   return 'RUNTIME_ERROR';
}

/**
 * Whether trying again could plausibly work.
 *
 * Deliberately narrow. A retryable failure invites another paid run, and an
 * agent's tools have side effects, so anything not clearly transient is
 * reported as final.
 */
function isRetryable(error: unknown): boolean {
   const status = (error as { status?: number })?.status;
   return status === 429 || (typeof status === 'number' && status >= 500);
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
         // Memoised on the promise, not on its result: two tool calls racing
         // would otherwise each create a workspace and one would be orphaned.
         opening ??= driver.createSession({ runId });
         return opening;
      },
      close: async () => {
         if (!opening) return;
         await opening.then((session) => session.destroy()).catch(() => undefined);
      },
   };
}
