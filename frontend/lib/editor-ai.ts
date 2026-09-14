import { apiFetch } from './api';

export interface EditorAssistRequest {
   text: string;
   instruction: string;
}

export interface EditorAssistResponse {
   text: string;
}

/**
 * Asks Berry to rewrite editor Markdown. The server returns Markdown only — no
 * outer fences or commentary.
 */
export async function assistEditorText(
   input: EditorAssistRequest,
   options?: { signal?: AbortSignal }
): Promise<string> {
   const body = (await apiFetch('/api/v1/editor/assist', {
      method: 'POST',
      body: JSON.stringify(input),
      signal: options?.signal,
   })) as EditorAssistResponse;
   return body.text;
}
