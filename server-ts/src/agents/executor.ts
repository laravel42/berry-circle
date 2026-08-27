import { randomUUID } from 'node:crypto';
import { LlmAgent, Runner, isFinalResponse } from '@google/adk';
import type { Event } from '@google/adk';
import type { Sql } from '../db/pool.ts';
import type { Storage } from '../storage/storage.ts';
import { RunLedger, RunTerminal, type Dispatch, type Usage } from '../runs/ledger.ts';
import { postRunResult, truncateUtf8 } from '../runs/result-comment.ts';
import { BerryArtifactService } from './artifact-service.ts';
import { BerrySessionService } from './session-service.ts';
import { OpenRouterLlm } from './openrouter-llm.ts';
import { berryTools } from './tools.ts';
import { buildMessage, lastRejection } from './prompt.ts';

/**
 * Runs one Berry run through ADK, writing the ledger Berry already keeps.
 *
 * This is what replaces internal/service/runadmission's consumption of the
 * OpenFang stream. The ledger does not change — the same `run_events`, the
 * same statuses, the same result comment on the task — because those are
 * product surfaces read by the run stream, the task timeline and the peer
 * reviewer. What changes is who produces them, and that the agent now has
 * tools that reach Berry itself.
 *
 * One failure from the OpenFang era is worth keeping in view, because it
 * shaped this loop. OpenFang emitted `done` at the end of every model turn and
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
}

export interface RunOutcome {
   runId: string;
   status: 'succeeded' | 'failed' | 'cancelled';
   summary: string | null;
   usage: Usage;
   toolCalls: number;
   failure?: { code: string; message: string; retryable: boolean };
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
            }),
         }),
         sessionService: sessions,
         artifactService: artifacts,
      });

      // Read before the run is marked running, so a reviewer's feedback is
      // part of the first message rather than something the agent learns late.
      const reviewFeedback = await lastRejection(this.sql, dispatch.issueId);

      await this.ledger.markRunning(dispatch.runId);
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
      const openTools = new Map<string, string>();
      let toolCalls = 0;

      try {
         for await (const event of runner.runAsync({
            userId: session.userId,
            sessionId: session.id,
            newMessage: {
               role: 'user',
               parts: [{ text: buildMessage({ ...dispatch, reviewFeedback }) }],
            },
         })) {
            if (signal?.aborted) throw new RunCancelled();
            toolCalls += await this.recordEvent(dispatch.runId, event, result, openTools);
            addUsage(usage, event);
            // ADK marks the end of a turn; the result accumulator needs it to
            // tell a report from the progress that preceded it.
            if (isTurnComplete(event)) result.endTurn();
         }
      } catch (error) {
         result.endTurn();
         if (error instanceof RunCancelled || signal?.aborted) {
            return this.cancel(dispatch, usage, toolCalls);
         }
         return this.fail(dispatch, error, usage, toolCalls);
      }

      result.endTurn();
      // Every tool the agent left open failed by omission: the iterator ended
      // without a response for it. Recording nothing would leave the run
      // stream showing a tool that never stops running.
      await this.closeOpenTools(dispatch.runId, openTools);
      return this.succeed(dispatch, result, usage, toolCalls);
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
      openTools: Map<string, string>
   ): Promise<number> {
      let toolCalls = 0;

      for (const part of event.content?.parts ?? []) {
         if (part.functionCall) {
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
         if (typeof part.text === 'string' && part.text !== '' && !part.thought) {
            result.append(part.text);
            await this.ledger.appendOutput(runId, 'progress', part.text);
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
