import {
   AfterInvocationEvent,
   AfterToolCallEvent,
   BeforeToolCallEvent,
   MessageAddedEvent,
   ModelContentBlockDeltaEvent,
   ModelStreamUpdateEvent,
   type LocalAgent,
   type Plugin,
} from '@strands-agents/sdk';
import { RunTerminal } from '../terminal.ts';
import { OutputBuffer } from '../output-buffer.ts';

/**
 * The run ledger, written from the agent's own lifecycle.
 *
 * This used to be a loop in the executor that read every SDK event, matched
 * its type as a string and decided what the ledger should hear. It is now the
 * SDK telling Berry, through typed hooks, exactly when a tool starts, when it
 * ends, and what the model said in between. The executor no longer reads
 * events at all.
 *
 * A tool call and its result are two rows here as they are in Berry: the pair
 * is what lets a run stream show a tool as running rather than only as having
 * run. Neither carries arguments or output — the ledger is public to everyone
 * who can see the task, and a tool's input is not.
 */

/** The slice of the ledger this plugin writes. Structural, so tests can fake it. */
export interface LedgerSink {
   appendToolStarted(runId: string, toolCallId: string, name: string): Promise<void>;
   appendToolCompleted(runId: string, toolCallId: string, succeeded: boolean): Promise<void>;
   appendOutput(runId: string, channel: string, text: string): Promise<void>;
}

export class LedgerPlugin implements Plugin {
   readonly name = 'berry:ledger';
   readonly #ledger: LedgerSink;
   readonly #runId: string;
   readonly #output: OutputBuffer;
   /** Tools the model has called and not yet heard back from. */
   readonly #open = new Map<string, string>();
   /**
    * Set once the ledger refuses a write because the run ended — cancelled
    * while a tool was draining. The run's own ending is already recorded, and
    * nothing that happens after it belongs in the record.
    */
   #terminal = false;

   constructor(options: { ledger: LedgerSink; runId: string }) {
      this.#ledger = options.ledger;
      this.#runId = options.runId;
      this.#output = new OutputBuffer((text) => this.#ledger.appendOutput(this.#runId, 'progress', text));
   }

   initAgent(agent: LocalAgent): void {
      // Text, as it is generated. This is what makes a run readable while it
      // runs rather than only once it is over.
      agent.addHook(ModelStreamUpdateEvent, async (event) => {
         const inner = event.event;
         if (inner instanceof ModelContentBlockDeltaEvent && inner.delta.type === 'textDelta') {
            const text = inner.delta.text;
            await this.#write(() => this.#output.add(text));
         }
      });

      agent.addHook(BeforeToolCallEvent, async (event) => {
         // Before the tool row, so the ledger reads in the order things
         // happened: the agent said something, then called something.
         await this.#write(() => this.#output.flush());
         this.#open.set(event.toolUse.toolUseId, event.toolUse.name);
         await this.#write(() =>
            this.#ledger.appendToolStarted(this.#runId, event.toolUse.toolUseId, event.toolUse.name)
         );
      });

      agent.addHook(AfterToolCallEvent, async (event) => {
         this.#open.delete(event.toolUse.toolUseId);
         // A thrown tool and a denied tool both arrive as an error result;
         // the ledger only learns by looking.
         const ok = !event.error && event.result.status !== 'error';
         await this.#write(() =>
            this.#ledger.appendToolCompleted(this.#runId, event.toolUse.toolUseId, ok)
         );
      });

      // The end of one model message, which the SDK adds after its tools have
      // run. Flushed here so the ledger never shows a turn ending before the
      // text that ended it.
      agent.addHook(MessageAddedEvent, async (event) => {
         if (event.message.role === 'assistant') await this.#write(() => this.#output.flush());
      });

      agent.addHook(AfterInvocationEvent, async () => {
         await this.#write(() => this.#output.flush());
         // Every tool the agent left open failed by omission: the loop ended
         // without a result for it. Recording nothing would leave the run
         // stream showing a tool that never stops running.
         for (const id of this.#open.keys()) {
            await this.#write(() => this.#ledger.appendToolCompleted(this.#runId, id, false));
         }
         this.#open.clear();
      });
   }

   /** Whatever is buffered, written now. For the executor's error path. */
   async flush(): Promise<void> {
      await this.#write(() => this.#output.flush());
   }

   async #write(operation: () => Promise<void>): Promise<void> {
      if (this.#terminal) return;
      try {
         await operation();
      } catch (error) {
         if (error instanceof RunTerminal) {
            this.#terminal = true;
            return;
         }
         throw error;
      }
   }
}
