import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   resolveAnswers,
   unansweredBlockers,
   UnansweredQuestion,
   UnknownQuestion,
} from './answers.ts';
import { withAnswers } from './generator.ts';
import type { Plan, PlanAssumption } from './schema.ts';

/**
 * Turning what a wizard submitted into what the planner is told.
 *
 * All offline. The rule under test throughout is that an answer's words come
 * from the plan whenever an option was picked — a client says which option,
 * never what it meant.
 */

function assumption(overrides: Partial<PlanAssumption> = {}): PlanAssumption {
   return {
      id: 'a1',
      description: 'What email volume?',
      confidence: 'medium',
      userEditable: false,
      blocking: true,
      options: [
         { id: 'o1', label: 'Real-time', detail: 'Under 500ms' },
         { id: 'o2', label: 'Nightly batch' },
      ],
      ...overrides,
   };
}

function planWith(assumptions: PlanAssumption[]): Plan {
   return {
      version: '1',
      goal: { tempId: 'goal-1', title: 'Ship the thing' },
      milestones: [],
      assumptions,
      requiredConnections: [],
      issues: [],
      approvals: [],
      dependencies: [],
   };
}

test('a picked option is recorded in the plan’s own words', () => {
   const resolved = resolveAnswers(planWith([assumption()]), [
      { assumptionId: 'a1', optionId: 'o2' },
   ]);
   assert.equal(resolved[0]!.answer, 'Nightly batch');
   assert.equal(resolved[0]!.chosenOption, 'o2');
});

test('an option’s detail travels with its label', () => {
   // The detail is what separates two options a planner worded alike, so
   // dropping it hands the planner a thinner answer than the person gave.
   const resolved = resolveAnswers(planWith([assumption()]), [
      { assumptionId: 'a1', optionId: 'o1' },
   ]);
   assert.equal(resolved[0]!.answer, 'Real-time — Under 500ms');
});

test('a client cannot supply the words for an option it picked', () => {
   // Otherwise the record could say "nightly batch" while the planner is
   // told "real-time".
   const resolved = resolveAnswers(planWith([assumption()]), [
      { assumptionId: 'a1', optionId: 'o2', text: 'actually real-time' },
   ]);
   assert.equal(resolved[0]!.answer, 'Nightly batch');
});

test('typed text answers a question with no options', () => {
   const resolved = resolveAnswers(planWith([assumption({ options: [] })]), [
      { assumptionId: 'a1', text: '  About 50k a day  ' },
   ]);
   assert.equal(resolved[0]!.answer, 'About 50k a day');
   assert.equal(resolved[0]!.chosenOption, null);
});

test('an answer to a question the plan never asked is refused', () => {
   assert.throws(
      () => resolveAnswers(planWith([assumption()]), [{ assumptionId: 'a9', text: 'hi' }]),
      UnknownQuestion
   );
});

test('an option that is not on the question is refused', () => {
   assert.throws(
      () => resolveAnswers(planWith([assumption()]), [{ assumptionId: 'a1', optionId: 'o9' }]),
      UnknownQuestion
   );
});

test('an empty answer is not an answer', () => {
   assert.throws(
      () => resolveAnswers(planWith([assumption()]), [{ assumptionId: 'a1', text: '   ' }]),
      UnansweredQuestion
   );
});

test('the same question cannot be answered twice in one round', () => {
   // Taking the last would silently discard the other.
   assert.throws(
      () =>
         resolveAnswers(planWith([assumption()]), [
            { assumptionId: 'a1', optionId: 'o1' },
            { assumptionId: 'a1', optionId: 'o2' },
         ]),
      UnknownQuestion
   );
});

test('a skipped optional question is allowed to stand', () => {
   const plan = planWith([
      assumption({ id: 'a1', blocking: true }),
      assumption({ id: 'a2', blocking: false }),
   ]);
   assert.deepEqual(unansweredBlockers(plan, new Set(['a1'])), []);
});

test('a skipped blocking question is named', () => {
   const plan = planWith([
      assumption({ id: 'a1', blocking: true }),
      assumption({ id: 'a2', blocking: true, description: 'Which provider?' }),
   ]);
   const missing = unansweredBlockers(plan, new Set(['a1']));
   assert.deepEqual(
      missing.map((entry) => entry.id),
      ['a2']
   );
});

test('answers reach the planner as settled fact', () => {
   const prompt = withAnswers('Classify my email', [
      { question: 'What email volume?', answer: 'Nightly batch' },
   ]);
   assert.match(prompt, /Classify my email/);
   assert.match(prompt, /What email volume\?/);
   assert.match(prompt, /Nightly batch/);
   // The planner re-asking what was just answered would block the plan a
   // second time on the thing the person resolved.
   assert.match(prompt, /Do not raise them again/);
});

test('a prompt with no answers is the prompt', () => {
   assert.equal(withAnswers('Classify my email', []), 'Classify my email');
});
