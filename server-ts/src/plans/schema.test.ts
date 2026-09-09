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
      milestones: [],
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
      milestone: null,
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
               options: [],
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

/**
 * Options on an assumption.
 *
 * The planner offers them because it is the only party that knows the
 * vocabulary of its own question. Everything here is about reading them
 * without letting a badly-shaped answer cost a plan that is otherwise fine.
 */

function assumptionFrom(entry: unknown) {
   const { plan } = readPlan({
      goal: { tempId: 'goal-1', title: 'Ship the thing' },
      assumptions: [entry],
      issues: [],
   });
   return plan.assumptions[0]!;
}

test('a question carries the options the planner offered', () => {
   const assumption = assumptionFrom({
      id: 'a1',
      description: 'What email volume?',
      blocking: true,
      options: [
         { id: 'o1', label: 'Real-time', detail: 'Classify on arrival' },
         { id: 'o2', label: 'Nightly batch' },
      ],
   });
   assert.deepEqual(assumption.options, [
      { id: 'o1', label: 'Real-time', detail: 'Classify on arrival' },
      { id: 'o2', label: 'Nightly batch' },
   ]);
});

test('a bare string is read as a label', () => {
   const assumption = assumptionFrom({
      id: 'a1',
      description: 'Which?',
      options: ['Real-time', 'Nightly batch'],
   });
   assert.deepEqual(
      assumption.options.map((option) => option.label),
      ['Real-time', 'Nightly batch']
   );
});

test('options the planner left out are simply absent', () => {
   // Every plan generated before options existed reads this way, and those
   // have to stay answerable rather than become unrenderable.
   assert.deepEqual(assumptionFrom({ id: 'a1', description: 'Which?' }).options, []);
});

test('a lone option is not a choice', () => {
   // Offering one asks a person to confirm the planner's guess, which is what
   // the blocking question already declined to do.
   assert.deepEqual(assumptionFrom({ id: 'a1', options: [{ label: 'The only way' }] }).options, []);
});

test('unlabelled options are dropped without failing the plan', () => {
   const assumption = assumptionFrom({
      id: 'a1',
      options: [{ label: '' }, { label: 'Real-time' }, { detail: 'no label' }, { label: 'Batch' }],
   });
   assert.deepEqual(
      assumption.options.map((option) => option.label),
      ['Real-time', 'Batch']
   );
});

test('two options cannot share an id', () => {
   // Which one was picked is the single fact the answer record must be sure of.
   const assumption = assumptionFrom({
      id: 'a1',
      options: [
         { id: 'o1', label: 'Real-time' },
         { id: 'o1', label: 'Batch' },
         { id: 'o2', label: 'Hourly' },
      ],
   });
   assert.deepEqual(
      assumption.options.map((option) => option.id),
      ['o1', 'o2']
   );
});

test('options are given ids when the planner omits them', () => {
   const assumption = assumptionFrom({ id: 'a1', options: ['Real-time', 'Batch'] });
   assert.deepEqual(
      assumption.options.map((option) => option.id),
      ['a1-o1', 'a1-o2']
   );
});

test('a flood of options is capped rather than passed through', () => {
   const assumption = assumptionFrom({
      id: 'a1',
      options: Array.from({ length: 40 }, (_, index) => `Option ${index}`),
   });
   assert.equal(assumption.options.length, 6);
});

test('an option that is not a list is no options at all', () => {
   assert.deepEqual(assumptionFrom({ id: 'a1', options: 'real-time' }).options, []);
});

// ------------------------------------------------------------- milestones

function milestone(tempId: string, title = `Milestone ${tempId}`) {
   return { tempId, title, description: null };
}

test('milestones are read, and each task names the one it belongs to', () => {
   const { plan, problems } = readPlan({
      goal: { title: 'Ship it' },
      milestones: [
         { tempId: 'm1', title: 'Foundations', description: 'Schema and auth' },
         { tempId: 'm2', title: 'Tickets' },
      ],
      issues: [
         { tempId: 't1', title: 'Create the schema', milestone: 'm1' },
         { tempId: 't2', title: 'Create a ticket', milestone: 'm2' },
      ],
   });
   assert.equal(problems.length, 0);
   assert.deepEqual(
      plan.milestones.map((m) => [m.tempId, m.title, m.description]),
      [
         ['m1', 'Foundations', 'Schema and auth'],
         ['m2', 'Tickets', null],
      ]
   );
   assert.deepEqual(
      plan.issues.map((issue) => issue.milestone),
      ['m1', 'm2']
   );
});

test('a plan with tasks and no milestones gets one from its goal, so an older answer still reads', () => {
   const { plan, problems } = readPlan({
      goal: { title: 'Ship it', description: 'All of it' },
      issues: [{ tempId: 't1', title: 'Do the work' }],
   });
   assert.equal(problems.length, 0);
   assert.equal(plan.milestones.length, 1);
   assert.equal(plan.milestones[0]?.title, 'Ship it');
   assert.equal(plan.issues[0]?.milestone, plan.milestones[0]?.tempId);
});

test('a milestone without a title is named as the problem', () => {
   const { problems } = readPlan({
      goal: { title: 'Ship it' },
      milestones: [{ tempId: 'm1' }],
      issues: [{ tempId: 't1', title: 'x', milestone: 'm1' }],
   });
   assert.ok(problems.some((problem) => problem.path === '/milestones/0/title'));
});

test('a task in a milestone the plan does not have is an error', () => {
   const report = validatePlan(
      planWith({
         milestones: [milestone('m1')],
         issues: [{ ...issue('a'), milestone: 'ghost' }],
      })
   );
   assert.equal(report.status, 'invalid');
   assert.ok(report.errors.some((error) => error.code === 'unknown_milestone'));
});

test('a milestone with no tasks is an error, because a goal groups work', () => {
   const report = validatePlan(
      planWith({
         milestones: [milestone('m1'), milestone('m2')],
         issues: [{ ...issue('a'), milestone: 'm1' }],
      })
   );
   assert.equal(report.status, 'invalid');
   assert.ok(
      report.errors.some((error) => error.code === 'empty_milestone' && error.path === '/milestones/1')
   );
});

test('a plan whose tasks each sit in a milestone that exists is valid', () => {
   const report = validatePlan(
      planWith({
         milestones: [milestone('m1'), milestone('m2')],
         issues: [
            { ...issue('a'), milestone: 'm1' },
            { ...issue('b', ['a']), milestone: 'm2' },
         ],
      })
   );
   assert.equal(report.status, 'valid');
});

test('a plan wrapped in a key the model chose is still the plan', () => {
   const { plan, problems } = readPlan({
      request: {
         goal: { title: 'Ship it' },
         milestones: [{ tempId: 'm1', title: 'First' }],
         issues: [{ tempId: 't1', title: 'Do the work', milestone: 'm1' }],
      },
   });
   assert.equal(problems.length, 0);
   assert.equal(plan.goal.title, 'Ship it');
   assert.equal(plan.issues.length, 1);
});
