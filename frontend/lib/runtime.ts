import { z } from 'zod';
import { apiFetch } from './api';

const modelSchema = z.object({
   id: z.string(),
   object: z.string(),
   ownedBy: z.string(),
});

const modelsResponseSchema = z.object({
   models: z.array(modelSchema),
});

const chatCompletionResponseSchema = z.object({
   model: z.string(),
   content: z.string(),
   usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
   }),
});

export type RuntimeModel = z.infer<typeof modelSchema>;

export type RuntimeChatCompletion = z.infer<typeof chatCompletionResponseSchema>;

/** List OpenFang-compatible models through the Berry API. */
export async function loadRuntimeModels(): Promise<RuntimeModel[]> {
   const json: unknown = await apiFetch('/api/v1/runtime/models');
   const parsed = modelsResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Runtime model list was not recognized');
   }
   return parsed.data.models;
}

/** Send a non-streaming chat completion probe through the Berry API. */
export async function probeRuntimeChat(input: {
   model: string;
   prompt: string;
}): Promise<RuntimeChatCompletion> {
   const json: unknown = await apiFetch('/api/v1/runtime/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
         model: input.model,
         messages: [{ role: 'user', content: input.prompt }],
      }),
   });
   const parsed = chatCompletionResponseSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Runtime chat response was not recognized');
   }
   return parsed.data;
}
