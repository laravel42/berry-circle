import {
   BedrockAgentCoreClient,
   CreateEventCommand,
   ListEventsCommand,
} from '@aws-sdk/client-bedrock-agentcore';

/**
 * What earlier runs did, so a retry does not start from nothing.
 *
 * Berry's run ledger already records every command and its output, but the
 * ledger is an audit trail: it is written for a person reading a run
 * afterwards, and nothing replays it into a prompt. So an agent handed the same
 * issue twice did the same work twice, including the parts that had already
 * failed. This is the missing half — the same history, in a form the next run
 * is actually told about.
 *
 * Keyed on the pair AgentCore's own model uses. The *actor* is the agent,
 * because an actor is the entity that participates across sessions; the
 * *session* is the issue, because the issue is the thread of work a run
 * belongs to. `ListEvents` requires both, and that keying is what makes "this
 * agent, on this issue, before now" a single query.
 *
 * Short-term events only. No `memoryStrategies` are configured on the resource,
 * which means no extraction role and — more importantly — no lag: an event is
 * readable the moment it is written, so two runs seconds apart still see each
 * other. Semantic long-term recall is a strategy added to the same resource
 * later; it would add derived records, not replace these events.
 *
 * Nothing here is allowed to fail a run. A recall that errors returns nothing
 * and the agent starts fresh, which is exactly the old behaviour; a record that
 * errors is dropped. Memory augments the ledger and the ledger is still the
 * durable record, so losing an event costs recall, not history.
 */

export interface AwsCredentialPair {
   accessKeyId: string;
   secretAccessKey: string;
   sessionToken?: string;
}

/** One thing an earlier run did, as it will be shown to the next one. */
export interface RecalledEvent {
   at: Date;
   role: 'ASSISTANT' | 'USER' | 'TOOL' | 'OTHER';
   text: string;
}

export interface RunMemory {
   /** Whether anything is actually stored. False makes the seam a no-op. */
   readonly enabled: boolean;
   /** What this agent did on this issue before now, oldest first. */
   recall(input: { agentId: string; issueId: string }): Promise<RecalledEvent[]>;
   /** Records one thing that happened. Never throws. */
   record(input: {
      agentId: string;
      issueId: string;
      role: RecalledEvent['role'];
      text: string;
      /** Kept as metadata so a recalled line can be traced to its run. */
      runId?: string;
   }): Promise<void>;
}

export interface AgentCoreRunMemoryOptions {
   region: string;
   memoryId: string;
   credentials?: AwsCredentialPair | null;
   client?: BedrockAgentCoreClient;
   clock?: () => Date;
   /** How many past events to recall. */
   maxRecall?: number;
   /** Where a dropped event is reported. */
   onError?: (operation: 'recall' | 'record', error: unknown) => void;
}

/**
 * A ceiling on recall, for the same reason the conversation transcript has one:
 * the prompt is a bill. The most recent events are the ones worth having.
 */
const DEFAULT_MAX_RECALL = 30;

/**
 * A single event's text is bounded before it is sent.
 *
 * An agent that dumps a build log into memory would otherwise pay for it on
 * every later run in the same issue. The tail is kept, because the end of a
 * command's output is where the failure is.
 */
const MAX_EVENT_TEXT = 4000;

export class AgentCoreRunMemory implements RunMemory {
   readonly enabled = true;
   readonly #client: BedrockAgentCoreClient;
   readonly #memoryId: string;
   readonly #clock: () => Date;
   readonly #maxRecall: number;
   readonly #onError: (operation: 'recall' | 'record', error: unknown) => void;

   constructor(options: AgentCoreRunMemoryOptions) {
      this.#client =
         options.client ??
         new BedrockAgentCoreClient({
            region: options.region,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
      this.#memoryId = options.memoryId;
      this.#clock = options.clock ?? (() => new Date());
      this.#maxRecall = options.maxRecall ?? DEFAULT_MAX_RECALL;
      this.#onError = options.onError ?? (() => {});
   }

   async recall(input: { agentId: string; issueId: string }): Promise<RecalledEvent[]> {
      try {
         const response = await this.#client.send(
            new ListEventsCommand({
               memoryId: this.#memoryId,
               actorId: actorFor(input.agentId),
               sessionId: sessionFor(input.issueId),
               includePayloads: true,
               maxResults: this.#maxRecall,
            })
         );
         const events = (response.events ?? []).flatMap((event) => {
            const at = event.eventTimestamp;
            if (!at) return [];
            return (event.payload ?? []).flatMap((entry) => {
               const text = entry.conversational?.content?.text?.trim();
               if (!text) return [];
               const role = entry.conversational?.role;
               return [
                  {
                     at,
                     role: isRole(role) ? role : ('OTHER' as const),
                     text,
                  },
               ];
            });
         });
         // Oldest first: recall is read as a story, and ListEvents returns the
         // newest first. Sorted rather than reversed because one event may
         // carry several payload entries.
         return events.sort((left, right) => left.at.getTime() - right.at.getTime());
      } catch (error) {
         this.#onError('recall', error);
         return [];
      }
   }

   async record(input: {
      agentId: string;
      issueId: string;
      role: RecalledEvent['role'];
      text: string;
      runId?: string;
   }): Promise<void> {
      const text = bounded(input.text);
      // An empty event is a row AWS charges for and nothing can read.
      if (!text) return;
      try {
         await this.#client.send(
            new CreateEventCommand({
               memoryId: this.#memoryId,
               actorId: actorFor(input.agentId),
               sessionId: sessionFor(input.issueId),
               eventTimestamp: this.#clock(),
               payload: [{ conversational: { role: input.role, content: { text } } }],
               ...(input.runId
                  ? { metadata: { runId: { stringValue: input.runId } } }
                  : {}),
            })
         );
      } catch (error) {
         this.#onError('record', error);
      }
   }
}

/** The seam when no memory is configured: present, and does nothing. */
export function nullRunMemory(): RunMemory {
   return {
      enabled: false,
      async recall() {
         return [];
      },
      async record() {},
   };
}

/**
 * Recall as a prompt fragment, or null when there is nothing to say.
 *
 * Null rather than an empty string on purpose: a heading with no items under it
 * reads as "you did nothing last time", which is a claim, and a first run has
 * no last time to make it about.
 */
export function recallPrompt(events: RecalledEvent[]): string | null {
   if (events.length === 0) return null;
   const lines = events.map((event) => `- ${event.text}`);
   return [
      'You have worked on this issue before. What you did, oldest first:',
      ...lines,
      'Continue from there rather than starting again. Do not repeat work that already succeeded.',
   ].join('\n');
}

/**
 * Ids are prefixed because an actor and a session share no namespace with each
 * other or with anything else in the store, and a bare UUID in a console gives
 * no clue which of Berry's tables it came from.
 */
function actorFor(agentId: string): string {
   return `agent-${agentId}`;
}

function sessionFor(issueId: string): string {
   return `issue-${issueId}`;
}

function bounded(text: string): string {
   const trimmed = text.trim();
   if (trimmed.length <= MAX_EVENT_TEXT) return trimmed;
   return `…${trimmed.slice(-MAX_EVENT_TEXT)}`;
}

function isRole(value: unknown): value is RecalledEvent['role'] {
   return value === 'ASSISTANT' || value === 'USER' || value === 'TOOL' || value === 'OTHER';
}
