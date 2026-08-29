import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inDependencyOrder, readPlan, validatePlan, type Plan } from './schema.ts';

/**
 * Reading a model's answer, and deciding whether it could be compiled.
 *
 * All offline: nothing here talks to a model or a database. That is the point
 * of the split — the validator is deterministic so that the same plan is the
 * same verdict every time it is read, and a test can say so.
 */

function planWith(overrides: Partial<Plan> = {}): Plan {
   return {
      version: '1',
      goal: { tempId: 'goal-1', title: 'Ship the thing' },
      assumptions: [],
      requiredConnections: [],
      issues: [],
      approvals: [],
      dependencies: [],
      ...overrides,
   };
}

function issue(tempId: string, dependsOn: string[] = []) {
   return {
      tempId,
      title: `Task ${tempId}`,
      description: null,
      type: 'issue',
      suggestedAgentId: null,
      requiredCapabilities: [],
      priority: null,
      dependsOn,
      requiresReview: false,
      requiresApproval: false,
      expectedArtifacts: [],
      estimate: null,
   };
}

// ---------------------------------------------------------------- reading

test('a terse answer is filled in rather than refused', () => {
   // Models are terse. A missing `dependsOn` is not a malformed plan.
   const { plan, problems } = readPlan({
      goal: { title: 'Ship it' },
      issues: [{ title: 'Do the work' }],
   });
   assert.equal(problems.length, 0);
   assert.equal(plan.goal.title, 'Ship it');
   assert.equal(plan.issues.length, 1);
   assert.deepEqual(plan.issues[0]!.dependsOn, []);
   assert.equal(plan.issues[0]!.tempId, 'issue-1');
});

test('prose instead of a plan is a plan with problems, not an exception', () => {
   const { plan, problems } = readPlan('I would start by looking at the repository.');
   assert.equal(plan.issues.length, 0);
   assert.ok(problems.some((problem) => problem.path === '/goal/title'));
});

test('a task with no title is named as the problem', () => {
   const { problems } = readPlan({
      goal: { title: 'Ship it' },
      issues: [{ title: 'Fine' }, { description: 'no title' }],
   });
   assert.deepEqual(
      problems.map((problem) => problem.path),
      ['/issues/1/title']
   );
});

test('a runaway plan is capped, and says so', () => {
   const { plan, problems } = readPlan({
      goal: { title: 'Ship it' },
      issues: Array.from({ length: 80 }, (_unused, index) => ({ title: `Task ${index}` })),
   });
   assert.equal(plan.issues.length, 50);
   assert.ok(problems.some((problem) => problem.code === 'too_long'));
});

// -------------------------------------------------------------- validating

test('a plan whose tasks all exist is valid', () => {
   const report = validatePlan(planWith({ issues: [issue('a'), issue('b', ['a'])] }));
   assert.equal(report.status, 'valid');
   assert.deepEqual(report.errors, []);
});

test('a dependency on a task that is not in the plan is an error', () => {
   // The failure this catches: compiling would write an edge to nothing, or
   // silently drop it and produce a task that starts too early.
   const report = validatePlan(planWith({ issues: [issue('a', ['ghost'])] }));
   assert.equal(report.status, 'invalid');
   assert.equal(report.errors[0]?.code, 'unknown_reference');
});

test('a task cannot wait for itself', () => {
   const report = validatePlan(planWith({ issues: [issue('a', ['a'])] }));
   assert.equal(report.status, 'invalid');
   assert.ok(report.errors.some((error) => error.code === 'self_reference'));
});

test('tasks waiting on each other in a circle are refused', () => {
   const report = validatePlan(
      planWith({ issues: [issue('a', ['c']), issue('b', ['a']), issue('c', ['b'])] })
   );
   assert.equal(report.status, 'invalid');
   assert.ok(report.errors.some((error) => error.code === 'cycle'));
});

test('an approval that gates nothing is an error', () => {
   const report = validatePlan(
      planWith({
         issues: [issue('a')],
         approvals: [
            {
               tempId: 'ap1',
               title: 'Approve',
               description: null,
               reason: 'because',
               target: { kind: 'issue', tempId: 'ghost' },
               approver: { type: 'role', role: 'admin' },
               timeout: null,
            },
         ],
      })
   );
   assert.equal(report.status, 'invalid');
});

test('a blocking question outranks everything else', () => {
   // A plan waiting on an answer is not a wrong plan, and telling someone to
   // fix errors would send them looking for the wrong thing.
   const report = validatePlan(
      planWith({
         issues: [issue('a', ['ghost'])],
         assumptions: [
            {
               id: 'a1',
               description: 'Which repository?',
               confidence: 'low',
               userEditable: true,
               blocking: true,
            },
         ],
      })
   );
   assert.equal(report.status, 'blocked');
   assert.deepEqual(report.ambiguities, [
      { id: 'a1', question: 'Which repository?', blocking: true },
   ]);
});

test('tasks with nowhere to check out are warned about, not refused', () => {
   // An agent given one of these fails at the clone, after the model has
   // already been paid for. Said before Start Plan rather than after.
   const noProject = validatePlan(planWith({ issues: [issue('a')] }), {
      context: { project: null },
   });
   assert.equal(noProject.status, 'valid');
   assert.equal(noProject.warnings[0]?.code, 'no_project');

   const noRepository = validatePlan(planWith({ issues: [issue('a')] }), {
      context: { project: { name: 'Platform', hasRepository: false } },
   });
   assert.equal(noRepository.warnings[0]?.code, 'no_repository');
   assert.match(noRepository.warnings[0]!.message, /Platform/);

   // A project with a repository is the case nobody needs telling about.
   const fine = validatePlan(planWith({ issues: [issue('a')] }), {
      context: { project: { name: 'Platform', hasRepository: true } },
   });
   assert.deepEqual(fine.warnings, []);
});

test('a plan with no tasks is not warned about having no repository', () => {
   // There is nothing to check out, so the warning would be noise.
   const report = validatePlan(planWith(), { context: { project: null } });
   assert.ok(!report.warnings.some((warning) => warning.code === 'no_project'));
});

test('an empty plan is a warning, not an error', () => {
   // "Berry found nothing to create" is a legitimate answer to a request.
   const report = validatePlan(planWith());
   assert.equal(report.status, 'valid');
   assert.equal(report.warnings[0]?.code, 'empty');
});

test('risk is counted from the plan, so it reads the same twice', () => {
   assert.equal(validatePlan(planWith({ issues: [issue('a')] })).risk, 'low');
   assert.equal(
      validatePlan(planWith({ issues: Array.from({ length: 8 }, (_u, i) => issue(`t${i}`)) })).risk,
      'medium'
   );
   assert.equal(
      validatePlan(planWith({ issues: Array.from({ length: 20 }, (_u, i) => issue(`t${i}`)) })).risk,
      'high'
   );
   // A task that needs a person to say yes makes the whole plan a commitment.
   const gated = { ...issue('a'), requiresApproval: true };
   assert.equal(validatePlan(planWith({ issues: [gated] })).risk, 'high');
});

// ----------------------------------------------------------------- ordering

test('every blocker is created before what it blocks', () => {
   // Compilation depends on this: a task created before its blocker cannot
   // have its edge written.
   const ordered = inDependencyOrder([issue('c', ['b']), issue('a'), issue('b', ['a'])]);
   assert.deepEqual(
      ordered.map((entry) => entry.tempId),
      ['a', 'b', 'c']
   );
});

test('a cycle still yields every task, because a compile must not drop one', () => {
   const ordered = inDependencyOrder([issue('a', ['b']), issue('b', ['a'])]);
   assert.equal(ordered.length, 2);
   assert.deepEqual(new Set(ordered.map((entry) => entry.tempId)), new Set(['a', 'b']));
});

test('a dependency on a task outside the plan does not lose the task', () => {
   const ordered = inDependencyOrder([issue('a', ['ghost'])]);
   assert.deepEqual(
      ordered.map((entry) => entry.tempId),
      ['a']
   );
});
