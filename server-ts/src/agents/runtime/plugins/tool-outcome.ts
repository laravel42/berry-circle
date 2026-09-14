import { AfterToolCallEvent, type LocalAgent, type Plugin } from '@strands-agents/sdk';

/**
 * What a thrown tool costs the run.
 *
 * Distinguishes a tool that *threw* — Berry's own code failed, storage was
 * down — from a command that *exited non-zero*, which is a result the model is
 * told to act on. Only the first is a candidate for failing the run, and only
 * for the tools whose failure means durable state was silently lost.
 */

export type ToolThrowPolicy = 'fail_run' | 'report';

export const TOOL_THROW_POLICY: Readonly<Record<string, ToolThrowPolicy>> = {
   write_file: 'fail_run',
};

export class ToolFailed extends Error {
   override readonly name = 'ToolFailed';
   readonly code = 'TOOL_FAILED';
   readonly tool: string;
   constructor(tool: string, cause: Error) {
      super(`${tool} failed: ${cause.message}`);
      this.tool = tool;
   }
}

export interface ToolFailure {
   tool: string;
   message: string;
   policy: ToolThrowPolicy;
}

export class ToolOutcomePlugin implements Plugin {
   readonly name = 'berry:tool-outcome';
   readonly failures: ToolFailure[] = [];
   readonly #policy: Readonly<Record<string, ToolThrowPolicy>>;

   constructor(options: { policy?: Readonly<Record<string, ToolThrowPolicy>> } = {}) {
      this.#policy = options.policy ?? TOOL_THROW_POLICY;
   }

   initAgent(agent: LocalAgent): void {
      agent.addHook(AfterToolCallEvent, (event) => {
         // A denied tool is an error result with no `error`; a thrown one has
         // both. Only the throw is Berry's failure to record.
         const thrown = event.error ?? event.result.error;
         if (!thrown) return;
         this.failures.push({
            tool: event.toolUse.name,
            message: thrown.message,
            policy: this.#policy[event.toolUse.name] ?? 'report',
         });
      });
   }

   /** The first failure the policy says ends the run, or null. */
   fatal(): ToolFailed | null {
      const fatal = this.failures.find((failure) => failure.policy === 'fail_run');
      return fatal ? new ToolFailed(fatal.tool, new Error(fatal.message)) : null;
   }
}
