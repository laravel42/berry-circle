import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PROMPT_CHARS, renderPrompt, type PromptContext } from './template.ts';

const context: PromptContext = {
   autopilot: { id: 'a1', name: 'Nightly triage' },
   trigger: { source: 'webhook', firedAt: '2026-09-10T07:00:00.000Z' },
   payload: { event: 'deploy', build: { id: 42, ok: true }, items: ['x', 'y'] },
};

test('placeholders read the autopilot, the trigger and the payload by path', () => {
   assert.equal(
      renderPrompt('{{autopilot.name}} on {{ trigger.source }} at {{trigger.firedAt}}: build {{payload.build.id}} ok={{payload.build.ok}} first={{payload.items.0}}', context),
      'Nightly triage on webhook at 2026-09-10T07:00:00.000Z: build 42 ok=true first=x'
   );
});

test('a path that leads nowhere renders as nothing rather than as the placeholder', () => {
   assert.equal(renderPrompt('[{{payload.missing.deep}}]', context), '[]');
});

test('an object renders as its JSON', () => {
   assert.equal(renderPrompt('{{payload.build}}', context), '{"id":42,"ok":true}');
});

test('inherited properties are not reachable from a template', () => {
   assert.equal(renderPrompt('[{{payload.constructor}}][{{payload.__proto__}}]', context), '[][]');
});

test('text arriving in a payload is not expanded a second time', () => {
   const sneaky = { ...context, payload: { note: '{{autopilot.id}}' } };
   assert.equal(renderPrompt('{{payload.note}}', sneaky), '{{autopilot.id}}');
});

test('the rendered prompt is capped', () => {
   const long = { ...context, payload: { text: 'x'.repeat(4_000) } };
   const rendered = renderPrompt('{{payload.text}}'.repeat(10), long);
   assert.equal(rendered.length, MAX_PROMPT_CHARS);
});
