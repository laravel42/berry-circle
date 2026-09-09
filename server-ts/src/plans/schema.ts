/**
 * BerryPlan v1 — what a plan proposes, and what makes it valid.
 *
 * A plan is not work. It is a proposal a person reads and then either starts
 * or throws away, and nothing it describes exists on a board until someone
 * presses Start Plan. That is the whole reason it has its own document shape
 * rather than being "some issues we made for you".
 *
 * The validator is deliberately deterministic — no model, no judgement. Its
 * job is to answer whether this document *could* be compiled: are the
 * dependencies real, is the graph acyclic, does every approval point at
 * something. A model deciding that would be a plan that validates differently
 * on Tuesday.
 */

export interface PlanGoal {
   tempId: string;
   title: string;
   description?: string | null;
   projectId?: string | null;
}

/**
 * One answer a person can pick for an assumption.
 *
 * The planner offers these because it is the only party that knows why it is
 * asking: a question about email volume wants "real-time" and "nightly batch",
 * not a text box the asker has to guess the vocabulary of.
 */
/**
 * A milestone: one outcome on the way to the goal, and the group its tasks
 * compile into. Each becomes a goal in the project when the plan starts.
 */
export interface PlanMilestone {
   tempId: string;
   title: string;
   description?: string | null;
}

export interface PlanAssumptionOption {
   id: string;
   label: string;
   /** One line on what picking this means, when the label is not self-evident. */
   detail?: string | null;
}

export interface PlanAssumption {
   id: string;
   description: string;
   confidence: 'low' | 'medium' | 'high';
   userEditable: boolean;
   blocking: boolean;
   /**
    * What a person may pick, or empty for a question only prose can answer.
    *
    * Empty is a legitimate answer to "what are the options", not a defect: it
    * is also what every plan generated before options existed reports, and
    * those must stay answerable rather than become unrenderable.
    */
   options: PlanAssumptionOption[];
}

export interface PlanIssue {
   tempId: string;
   title: string;
   description?: string | null;
   type: string;
   suggestedAgentId?: string | null;
   requiredCapabilities: string[];
   priority?: string | null;
   dependsOn: string[];
   requiresReview: boolean;
   requiresApproval: boolean;
   expectedArtifacts: string[];
   estimate?: string | null;
   /** The milestone this task belongs to, by `tempId`. */
   milestone: string | null;
}

export interface PlanApproval {
   tempId: string;
   title: string;
   description?: string | null;
   reason: string;
   target: { kind: string; tempId: string };
   approver: { type: string; userId?: string | null; role?: string | null };
   timeout?: string | null;
}

export interface PlanDependency {
   from: string;
   to: string;
   kind: string;
}

export interface Plan {
   version: string;
   goal: PlanGoal;
   /** In delivery order. Never empty when there are tasks: the reader sees to that. */
   milestones: PlanMilestone[];
   assumptions: PlanAssumption[];
   requiredConnections: Array<{ provider: string; purpose: string; connected: boolean }>;
   issues: PlanIssue[];
   approvals: PlanApproval[];
   dependencies: PlanDependency[];
   confidence?: number;
}

export interface FieldProblem {
   path: string;
   code: string;
   message: string;
}

export interface ValidationReport {
   status: 'unknown' | 'valid' | 'invalid' | 'blocked';
   errors: FieldProblem[];
   warnings: FieldProblem[];
   requiredConnections: Array<{ provider: string; purpose: string; connected: boolean }>;
   ambiguities: Array<{ id: string; question: string; blocking: boolean }>;
   risk: 'low' | 'medium' | 'high';
   needsAdminActivation: boolean;
}

const MAX_ISSUES = 50;
const MAX_MILESTONES = 12;
const MAX_TITLE = 200;
const MAX_OPTIONS = 6;
const MAX_OPTION_LABEL = 120;
const MAX_OPTION_DETAIL = 300;

/**
 * Reads whatever the model produced into a plan, or says why it cannot.
 *
 * Lenient about shape and strict about meaning: a missing `dependsOn` is an
 * empty array, but a `dependsOn` naming a task that is not in the plan is an
 * error — the first is a model being terse and the second is a plan that
 * cannot be compiled.
 */
export function readPlan(raw: unknown): { plan: Plan; problems: FieldProblem[] } {
   const problems: FieldProblem[] = [];
   const source = unwrapped(isRecord(raw) ? raw : {});

   const goalSource = isRecord(source.goal) ? source.goal : {};
   const goal: PlanGoal = {
      tempId: text(goalSource.tempId) || 'goal-1',
      title: text(goalSource.title),
      description: text(goalSource.description) || null,
      projectId: text(goalSource.projectId) || null,
   };
   if (goal.title === '') {
      problems.push({ path: '/goal/title', code: 'required', message: 'The plan needs a goal.' });
   }

   const milestones: PlanMilestone[] = [];
   const rawMilestones = Array.isArray(source.milestones) ? source.milestones : [];
   if (rawMilestones.length > MAX_MILESTONES) {
      problems.push({
         path: '/milestones',
         code: 'too_long',
         message: `A plan proposes at most ${MAX_MILESTONES} milestones.`,
      });
   }
   rawMilestones.slice(0, MAX_MILESTONES).forEach((entry, index) => {
      const item = isRecord(entry) ? entry : {};
      const title = text(item.title);
      if (title === '') {
         problems.push({
            path: `/milestones/${index}/title`,
            code: 'required',
            message: 'Every milestone needs a title.',
         });
      }
      milestones.push({
         tempId: text(item.tempId) || `milestone-${index + 1}`,
         title: title.slice(0, MAX_TITLE),
         description: text(item.description) || null,
      });
   });

   const issues: PlanIssue[] = [];
   const rawIssues = Array.isArray(source.issues) ? source.issues : [];
   if (rawIssues.length > MAX_ISSUES) {
      problems.push({
         path: '/issues',
         code: 'too_long',
         message: `A plan proposes at most ${MAX_ISSUES} tasks.`,
      });
   }
   rawIssues.slice(0, MAX_ISSUES).forEach((entry, index) => {
      const item = isRecord(entry) ? entry : {};
      const tempId = text(item.tempId) || `issue-${index + 1}`;
      const title = text(item.title);
      if (title === '') {
         problems.push({
            path: `/issues/${index}/title`,
            code: 'required',
            message: 'Every task needs a title.',
         });
      }
      issues.push({
         tempId,
         title: title.slice(0, MAX_TITLE),
         description: text(item.description) || null,
         type: text(item.type) || 'issue',
         suggestedAgentId: text(item.suggestedAgentId) || null,
         requiredCapabilities: strings(item.requiredCapabilities),
         priority: text(item.priority) || null,
         dependsOn: strings(item.dependsOn),
         requiresReview: item.requiresReview === true,
         requiresApproval: item.requiresApproval === true,
         expectedArtifacts: strings(item.expectedArtifacts),
         estimate: text(item.estimate) || null,
         milestone: text(item.milestone) || null,
      });
   });

   // A plan written before milestones existed, or by a model that skipped
   // them, is read as one milestone standing for the goal rather than
   // refused: the tasks are still work, and one group is still a group.
   if (milestones.length === 0 && issues.length > 0) {
      const single: PlanMilestone = {
         tempId: goal.tempId,
         title: goal.title || 'Milestone 1',
         description: goal.description ?? null,
      };
      milestones.push(single);
      for (const issue of issues) issue.milestone = single.tempId;
   }

   const approvals: PlanApproval[] = (Array.isArray(source.approvals) ? source.approvals : []).map(
      (entry, index) => {
         const item = isRecord(entry) ? entry : {};
         const target = isRecord(item.target) ? item.target : {};
         return {
            tempId: text(item.tempId) || `approval-${index + 1}`,
            title: text(item.title) || 'Approval',
            description: text(item.description) || null,
            reason: text(item.reason) || 'This step needs a person to say yes.',
            target: { kind: text(target.kind) || 'issue', tempId: text(target.tempId) },
            approver: { type: 'role', role: 'admin' },
            timeout: null,
         };
      }
   );

   const dependencies: PlanDependency[] = (
      Array.isArray(source.dependencies) ? source.dependencies : []
   ).map((entry) => {
      const item = isRecord(entry) ? entry : {};
      return {
         from: text(item.from),
         to: text(item.to),
         kind: text(item.kind) || 'blocks',
      };
   });

   const assumptions: PlanAssumption[] = (
      Array.isArray(source.assumptions) ? source.assumptions : []
   ).map((entry, index) => {
      const item = isRecord(entry) ? entry : {};
      const confidence = text(item.confidence);
      return {
         id: text(item.id) || `assumption-${index + 1}`,
         description: text(item.description),
         confidence:
            confidence === 'low' || confidence === 'high' ? confidence : ('medium' as const),
         userEditable: item.userEditable === true,
         blocking: item.blocking === true,
         options: readOptions(item.options, index),
      };
   });

   return {
      plan: {
         version: '1',
         goal,
         milestones,
         assumptions,
         requiredConnections: [],
         issues,
         approvals,
         dependencies,
         ...(typeof source.confidence === 'number' ? { confidence: source.confidence } : {}),
      },
      problems,
   };
}

const PLAN_KEYS = ['goal', 'milestones', 'issues', 'assumptions', 'approvals'];

/**
 * A plan handed over inside a wrapper — `{ "request": { "goal": … } }` — is
 * read as the plan. A model asked for "an object" sometimes names the object,
 * and losing a whole plan to the name it chose is not a useful strictness.
 */
function unwrapped(source: Record<string, unknown>): Record<string, unknown> {
   if (PLAN_KEYS.some((key) => key in source)) return source;
   const keys = Object.keys(source);
   if (keys.length !== 1) return source;
   const inner = source[keys[0]!];
   return isRecord(inner) && PLAN_KEYS.some((key) => key in inner) ? inner : source;
}

/**
 * What the plan will land in, when the caller knows.
 *
 * Passed in rather than looked up, so the validator stays a pure function of
 * its inputs: the same plan and the same context are the same verdict, which
 * is the property that makes a plan's risk mean anything.
 */
export interface PlanContext {
   /** A project for the tasks to land in, or null when the plan names none. */
   project: { name: string; hasRepository: boolean } | null;
}

/**
 * Whether this plan could be compiled.
 *
 * `blocked` outranks `invalid`: a plan whose assumptions carry a blocking
 * question is not wrong, it is unanswered, and telling someone to fix errors
 * in a plan that is waiting on them would send them looking for the wrong
 * thing.
 */
export function validatePlan(
   plan: Plan,
   context: { seed?: FieldProblem[]; context?: PlanContext } = {}
): ValidationReport {
   const errors: FieldProblem[] = [...(context.seed ?? [])];
   const warnings: FieldProblem[] = [];

   const byTempId = new Map(plan.issues.map((issue) => [issue.tempId, issue]));
   if (byTempId.size !== plan.issues.length) {
      errors.push({
         path: '/issues',
         code: 'duplicate',
         message: 'Two tasks share an identifier.',
      });
   }
   if (plan.issues.length === 0) {
      warnings.push({
         path: '/issues',
         code: 'empty',
         message: 'This plan proposes no tasks.',
      });
   }

   plan.issues.forEach((issue, index) => {
      for (const dependency of issue.dependsOn) {
         if (!byTempId.has(dependency)) {
            errors.push({
               path: `/issues/${index}/dependsOn`,
               code: 'unknown_reference',
               message: `"${dependency}" is not a task in this plan.`,
            });
         }
      }
      if (issue.dependsOn.includes(issue.tempId)) {
         errors.push({
            path: `/issues/${index}/dependsOn`,
            code: 'self_reference',
            message: 'A task cannot wait for itself.',
         });
      }
   });

   plan.approvals.forEach((approval, index) => {
      if (!byTempId.has(approval.target.tempId)) {
         errors.push({
            path: `/approvals/${index}/target`,
            code: 'unknown_reference',
            message: 'This approval gates nothing in the plan.',
         });
      }
   });

   // Milestones are checked only when the plan has them; the reader gives
   // every real plan at least one, and a hand-built fixture without any is
   // not making a claim about grouping.
   if (plan.milestones.length > 0) {
      const known = new Set(plan.milestones.map((milestone) => milestone.tempId));
      plan.issues.forEach((issue, index) => {
         if (issue.milestone === null || !known.has(issue.milestone)) {
            errors.push({
               path: `/issues/${index}/milestone`,
               code: 'unknown_milestone',
               message: `"${issue.title}" belongs to a milestone the plan does not have.`,
            });
         }
      });
      plan.milestones.forEach((milestone, index) => {
         if (!plan.issues.some((issue) => issue.milestone === milestone.tempId)) {
            errors.push({
               path: `/milestones/${index}`,
               code: 'empty_milestone',
               message: `"${milestone.title}" has no tasks. A milestone is the group of work that reaches it.`,
            });
         }
      });
   }

   if (errors.length === 0 && hasCycle(plan.issues)) {
      errors.push({
         path: '/issues',
         code: 'cycle',
         message: 'These tasks wait on each other in a circle.',
      });
   }

   // Warned rather than refused, and only when there is work to warn about.
   // A plan of writing and decisions is a legitimate plan; one whose tasks
   // are code with nowhere to check it out is a plan whose agents will fail
   // at the first command, and that is worth saying before Start Plan rather
   // than after.
   if (plan.issues.length > 0 && context.context) {
      const project = context.context.project;
      if (!project) {
         warnings.push({
            path: '/goal',
            code: 'no_project',
            message:
               'These tasks are not in a project, so an agent has no repository to check out.',
         });
      } else if (!project.hasRepository) {
         warnings.push({
            path: '/goal',
            code: 'no_repository',
            message: `${project.name} has no repository linked, so an agent has nothing to check out.`,
         });
      }
   }

   const ambiguities = plan.assumptions
      .filter((assumption) => assumption.blocking)
      .map((assumption) => ({
         id: assumption.id,
         question: assumption.description,
         blocking: true,
      }));

   const risk = riskOf(plan);
   return {
      status:
         ambiguities.length > 0 ? 'blocked' : errors.length > 0 ? 'invalid' : 'valid',
      errors,
      warnings,
      requiredConnections: plan.requiredConnections,
      ambiguities,
      risk,
      // Nothing in a plan activates itself any more; kept because the field is
      // in the contract and the page reads it.
      needsAdminActivation: false,
   };
}

/**
 * How much of a commitment starting this plan is.
 *
 * Counted from what the plan says rather than guessed by a model, so the same
 * plan is the same risk every time it is read.
 */
function riskOf(plan: Plan): 'low' | 'medium' | 'high' {
   if (plan.issues.some((issue) => issue.requiresApproval)) return 'high';
   if (plan.issues.length > 12) return 'high';
   if (plan.issues.length > 5) return 'medium';
   return 'low';
}

/** Depth-first, three colours: white unseen, grey on the stack, black done. */
function hasCycle(issues: PlanIssue[]): boolean {
   const byTempId = new Map(issues.map((issue) => [issue.tempId, issue]));
   const state = new Map<string, 'grey' | 'black'>();

   const visit = (tempId: string): boolean => {
      const colour = state.get(tempId);
      if (colour === 'grey') return true;
      if (colour === 'black') return false;
      state.set(tempId, 'grey');
      for (const next of byTempId.get(tempId)?.dependsOn ?? []) {
         if (byTempId.has(next) && visit(next)) return true;
      }
      state.set(tempId, 'black');
      return false;
   };

   return issues.some((issue) => visit(issue.tempId));
}

/**
 * Tasks in an order where every blocker comes before what it blocks.
 *
 * Compilation needs this: a task created before the one it depends on cannot
 * have its edge written, and creating them in the model's order would work
 * only by luck. Anything left over after the sort — which only happens in a
 * cycle the validator should already have refused — is appended, so a compile
 * never silently drops a task.
 */
export function inDependencyOrder(issues: PlanIssue[]): PlanIssue[] {
   const byTempId = new Map(issues.map((issue) => [issue.tempId, issue]));
   const ordered: PlanIssue[] = [];
   const done = new Set<string>();
   const active = new Set<string>();

   const visit = (tempId: string): void => {
      if (done.has(tempId) || active.has(tempId)) return;
      const issue = byTempId.get(tempId);
      if (!issue) return;
      active.add(tempId);
      for (const dependency of issue.dependsOn) visit(dependency);
      active.delete(tempId);
      done.add(tempId);
      ordered.push(issue);
   };

   for (const issue of issues) visit(issue.tempId);
   for (const issue of issues) if (!done.has(issue.tempId)) ordered.push(issue);
   return ordered;
}

/**
 * The options offered for one assumption, read leniently.
 *
 * Lenient like the rest of `readPlan`: a model that omits options, or emits
 * them as strings, or labels one with an empty string, has asked a question
 * that prose can still answer — so the bad entries are dropped rather than
 * failing the whole document. A plan is not invalid for being asked badly.
 *
 * Capped because the count is a UI promise as much as a limit: a picker is a
 * picker at four options and a form at forty.
 */
function readOptions(value: unknown, assumptionIndex: number): PlanAssumptionOption[] {
   if (!Array.isArray(value)) return [];
   const options: PlanAssumptionOption[] = [];
   const seen = new Set<string>();
   for (const [index, entry] of value.entries()) {
      if (options.length >= MAX_OPTIONS) break;
      // A bare string is a label, which is how a model shortens the shape when
      // it has nothing to add beyond the name.
      const item = typeof entry === 'string' ? { label: entry } : isRecord(entry) ? entry : {};
      const label = text(item.label).slice(0, MAX_OPTION_LABEL);
      if (label === '') continue;
      const id = text(item.id) || `a${assumptionIndex + 1}-o${index + 1}`;
      // Two options sharing an id would make the answer ambiguous about which
      // was picked, which is the one thing this record has to be sure of.
      if (seen.has(id)) continue;
      seen.add(id);
      const detail = text(item.detail).slice(0, MAX_OPTION_DETAIL);
      options.push({ id, label, ...(detail ? { detail } : {}) });
   }
   // One option is not a choice. Offering it would ask a person to confirm the
   // planner's guess, which is what the blocking question already refuses to do.
   return options.length > 1 ? options : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
   return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [];
}
