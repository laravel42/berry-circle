import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { EditorAssist, EditorAssistUnavailable } from '../editor/assist.ts';

const MAX_TEXT = 20_000;
const MAX_INSTRUCTION = 2_000;

export interface EditorOptions {
   sessions: SessionService;
   assist: EditorAssist | null;
}

export function editorMounts(options: EditorOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   route.post('/assist', async (context) => {
      if (!options.assist) {
         throw new ApiError(503, 'EDITOR_UNAVAILABLE', 'Editor assistance is not configured.');
      }

      const { value } = await decodeBody<{ text?: string; instruction?: string }>(context, {
         text: 'string',
         instruction: 'string',
      });

      const text = (value.text ?? '').trim();
      const instruction = (value.instruction ?? '').trim();
      const fields = [];
      if (text === '') {
         fields.push(fieldError('/text', 'required', 'text is required.'));
      } else if (text.length > MAX_TEXT) {
         fields.push(fieldError('/text', 'too_long', `text is at most ${MAX_TEXT} characters.`));
      }
      if (instruction === '') {
         fields.push(fieldError('/instruction', 'required', 'instruction is required.'));
      } else if (instruction.length > MAX_INSTRUCTION) {
         fields.push(
            fieldError(
               '/instruction',
               'too_long',
               `instruction is at most ${MAX_INSTRUCTION} characters.`
            )
         );
      }
      assertValid(fields);

      // Before the call, so a session with no workspace is a 404 rather than
      // an assistant failure.
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      const controller = new AbortController();
      context.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });

      try {
         const rewritten = await options.assist.rewrite({
            workspaceId,
            text,
            instruction,
            signal: controller.signal,
         });
         return json({ text: rewritten });
      } catch (error) {
         if (error instanceof EditorAssistUnavailable) {
            throw new ApiError(
               503,
               'EDITOR_UNAVAILABLE',
               `Editor assistance could not complete: ${error.message}.`
            );
         }
         throw error;
      }
   });

   return [{ prefix: '/api/v1/editor', handler: route }];
}

function currentWorkspace(workspaceId: string | null | undefined): string {
   if (!workspaceId) throw ApiError.notFound('Workspace');
   return workspaceId;
}
