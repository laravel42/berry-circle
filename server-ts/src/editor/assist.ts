import type { RuntimeCompletion } from '../runtime/completion.ts';
const SYSTEM = `You rewrite Markdown for a product editor.

The input may already be Markdown. Return only Markdown — keep headings, lists,
links, and emphasis when they still make sense. Do not wrap the answer in
markdown fences, do not add commentary, and do not explain what you changed.`;

export class EditorAssistUnavailable extends Error {
   override readonly name = 'EditorAssistUnavailable';
}

export interface EditorAssistOptions {
   defaultModel: string;
   /** Runs each call as a completion task on the runtime (ADR-0014). */
   completion: Pick<RuntimeCompletion, 'text'>;
   timeoutMs?: number;
}

export class EditorAssist {
   readonly #completion: Pick<RuntimeCompletion, 'text'>;
   readonly #defaultModel: string;
   readonly #timeoutMs: number;

   constructor(options: EditorAssistOptions) {
      this.#completion = options.completion;
      this.#defaultModel = options.defaultModel;
      this.#timeoutMs = options.timeoutMs ?? 60_000;
   }

   async rewrite(input: {
      workspaceId: string;
      text: string;
      instruction: string;
      signal?: AbortSignal;
   }): Promise<string> {
      const text = input.text.trim();
      const instruction = input.instruction.trim();
      if (text === '' || instruction === '') {
         throw new EditorAssistUnavailable('nothing to rewrite');
      }

      const result = await this.#completion
         .text({
            workspaceId: input.workspaceId,
            purpose: 'editor_assist',
            model: this.#defaultModel,
            system: SYSTEM,
            user: `Instruction: ${instruction}\n\nText:\n${text}`,
            ...(input.signal ? { signal: input.signal } : {}),
         })
         .catch((cause: unknown) => {
            throw new EditorAssistUnavailable(
               `the editor assistant could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`
            );
         });

      const content = result.value;
      if (content.trim() === '') {
         throw new EditorAssistUnavailable('the editor assistant answered with nothing to read');
      }

      const rewritten = stripMarkdownFences(content.trim());
      if (rewritten === '') {
         throw new EditorAssistUnavailable('the editor assistant returned empty text');
      }
      return rewritten;
   }
}

function stripMarkdownFences(text: string): string {
   const fenced = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
   return (fenced?.[1] ?? text).trim();
}
