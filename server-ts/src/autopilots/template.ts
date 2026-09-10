/**
 * An autopilot's prompt, with the firing's facts filled in.
 *
 * Substitution only: `{{autopilot.name}}`, `{{trigger.firedAt}}`,
 * `{{payload.build.id}}`. No expressions, no helpers, no loops — a template
 * language that can evaluate anything is a way for a webhook sender to run
 * code on this server. One pass, so text that arrives in a payload is never
 * itself treated as a template.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const MAX_VALUE_CHARS = 4_000;
export const MAX_PROMPT_CHARS = 20_000;

export interface PromptContext {
   autopilot: { id: string; name: string };
   trigger: { source: string; firedAt: string };
   payload: unknown;
}

export function renderPrompt(template: string, context: PromptContext): string {
   const rendered = template.replace(PLACEHOLDER, (_whole, path: string) =>
      stringify(lookup(context, path.split('.')))
   );
   return rendered.length > MAX_PROMPT_CHARS ? rendered.slice(0, MAX_PROMPT_CHARS) : rendered;
}

function lookup(root: unknown, path: string[]): unknown {
   let current: unknown = root;
   for (const key of path) {
      if (current === null || typeof current !== 'object') return undefined;
      // Own properties only: `constructor` and `__proto__` are not data.
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
   }
   return current;
}

function stringify(value: unknown): string {
   if (value === undefined || value === null) return '';
   if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
   if (typeof value === 'number' || typeof value === 'boolean') return String(value);
   return JSON.stringify(value).slice(0, MAX_VALUE_CHARS);
}
