import { ToolUnavailableError } from './errors.ts';
import type { ToolDefinition } from './gateway-client.ts';

/**
 * Which gateway tool performs which Berry capability.
 *
 * No tool name is written down here, and that is the point. A gateway's tool
 * names come from how its targets were configured — `github___create_issue`,
 * `createIssue`, `github.issue.create` are all plausible and all correct for
 * somebody — so a name compiled into Berry would be a guess that happens to
 * work on one deployment.
 *
 * Instead each capability carries the *words* that identify it, and resolution
 * happens once at startup against what the gateway actually reported. An
 * operator whose names defeat the matching supplies an explicit map and
 * nothing has to be guessed at all.
 */

/** What Berry needs a source-control gateway to be able to do. */
export type Capability =
   | 'getRepository'
   | 'createRepository'
   | 'listRepositories'
   | 'createIssue'
   | 'updateIssue'
   | 'getIssue'
   | 'listIssues'
   | 'createMilestone'
   | 'updateMilestone'
   | 'listMilestones'
   | 'createPullRequest'
   | 'getPullRequest'
   | 'listPullRequests'
   | 'mergePullRequest'
   | 'listPullRequestReviews'
   | 'createBranch'
   | 'listBranches';

/**
 * The capabilities Berry cannot work without.
 *
 * Everything else degrades: without `mergePullRequest` a person merges in
 * GitHub, and Berry still tracks the review. Without `createIssue` a task
 * never reaches GitHub at all, which is the integration not working.
 */
export const REQUIRED: readonly Capability[] = [
   'getRepository',
   'createIssue',
   'updateIssue',
   'createMilestone',
   'createPullRequest',
];

/**
 * The words that identify each capability, most specific first.
 *
 * Matched against a tool's name and description with the separators removed,
 * so `github___create_issue`, `createIssue` and `github.issue.create` all
 * reduce to the same thing. `mustNot` is what keeps `createIssue` from
 * claiming `createIssueComment`, which is the mistake this would otherwise
 * make on almost every real gateway.
 */
interface Pattern {
   verbs: string[];
   nouns: string[];
   mustNot?: string[];
}

const PATTERNS: Record<Capability, Pattern> = {
   getRepository: { verbs: ['get'], nouns: ['repository', 'repo'] },
   createRepository: { verbs: ['create'], nouns: ['repository', 'repo'] },
   listRepositories: { verbs: ['list', 'search'], nouns: ['repository', 'repo'] },
   createIssue: {
      verbs: ['create'],
      nouns: ['issue'],
      mustNot: ['comment', 'label', 'pull', 'milestone'],
   },
   updateIssue: {
      verbs: ['update', 'edit', 'patch'],
      nouns: ['issue'],
      mustNot: ['comment', 'label', 'pull'],
   },
   getIssue: { verbs: ['get'], nouns: ['issue'], mustNot: ['comment', 'pull'] },
   listIssues: { verbs: ['list', 'search'], nouns: ['issue'], mustNot: ['comment', 'pull'] },
   createMilestone: { verbs: ['create'], nouns: ['milestone'] },
   updateMilestone: { verbs: ['update', 'edit', 'patch'], nouns: ['milestone'] },
   listMilestones: { verbs: ['list'], nouns: ['milestone'] },
   createPullRequest: { verbs: ['create'], nouns: ['pullrequest', 'pull'], mustNot: ['comment', 'review'] },
   getPullRequest: { verbs: ['get'], nouns: ['pullrequest', 'pull'], mustNot: ['comment', 'review', 'file'] },
   listPullRequests: { verbs: ['list'], nouns: ['pullrequest', 'pull'], mustNot: ['comment', 'review'] },
   mergePullRequest: { verbs: ['merge'], nouns: ['pullrequest', 'pull'] },
   listPullRequestReviews: { verbs: ['list', 'get'], nouns: ['review'] },
   createBranch: { verbs: ['create'], nouns: ['branch'] },
   listBranches: { verbs: ['list'], nouns: ['branch'] },
};

export interface ResolvedTools {
   /** The tool name for a capability, or null when the gateway has none. */
   name(capability: Capability): string | null;
   /** The tool name, or a named failure. Used for capabilities Berry needs. */
   require(capability: Capability): string;
   /** Every capability the gateway can serve. */
   available(): Capability[];
   /** Every tool the gateway reported, for diagnostics. */
   tools(): string[];
}

/**
 * Matches Berry's capabilities to the gateway's tools.
 *
 * `overrides` wins outright: an operator who names a tool has settled the
 * question, and no amount of pattern matching should second-guess them. A name
 * that is not on the gateway is reported rather than ignored, because a typo
 * in a mapping is otherwise indistinguishable from a missing tool.
 */
export function resolveTools(
   discovered: ToolDefinition[],
   overrides: Partial<Record<Capability, string>> = {}
): ResolvedTools {
   const byName = new Map(discovered.map((tool) => [tool.name, tool]));
   const resolved = new Map<Capability, string>();
   const problems: string[] = [];

   for (const [capability, name] of Object.entries(overrides) as Array<[Capability, string]>) {
      if (!name) continue;
      if (!byName.has(name)) {
         problems.push(`${capability} is mapped to "${name}", which the gateway does not expose`);
         continue;
      }
      resolved.set(capability, name);
   }

   for (const capability of Object.keys(PATTERNS) as Capability[]) {
      if (resolved.has(capability)) continue;
      const match = bestMatch(PATTERNS[capability], discovered);
      if (match) resolved.set(capability, match);
   }

   const names = discovered.map((tool) => tool.name);
   return {
      name: (capability) => resolved.get(capability) ?? null,
      require(capability) {
         const name = resolved.get(capability);
         if (!name) throw new ToolUnavailableError(capability, names);
         return name;
      },
      available: () => [...resolved.keys()],
      tools: () => names,
      // Surfaced so a bad override is reported at startup rather than silently
      // falling through to a pattern match that finds something else.
      ...(problems.length > 0 ? { problems } : {}),
   } as ResolvedTools;
}

/**
 * The best tool for a pattern, or nothing.
 *
 * Scored rather than first-match: a gateway commonly exposes several tools
 * whose names contain "issue", and the shortest name that carries the verb and
 * the noun is almost always the plain operation rather than a variant of it.
 */
function bestMatch(pattern: Pattern, tools: ToolDefinition[]): string | null {
   let best: { name: string; score: number } | null = null;

   for (const tool of tools) {
      const name = normalize(tool.name);
      if (pattern.mustNot?.some((word) => name.includes(word))) continue;
      if (!pattern.nouns.some((noun) => name.includes(noun))) continue;
      if (!pattern.verbs.some((verb) => name.includes(verb))) continue;

      // Shorter wins: `createissue` over `createissuefromtemplate`.
      const score = 1000 - name.length;
      if (!best || score > best.score) best = { name: tool.name, score };
   }
   return best?.name ?? null;
}

/** A tool name reduced to letters, so separators and case stop mattering. */
function normalize(name: string): string {
   return name.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The capabilities Berry needs that this gateway cannot serve.
 *
 * Returned rather than thrown so a caller can decide: the server refuses to
 * start on a missing required capability, and a diagnostics endpoint merely
 * reports it.
 */
export function missingRequired(resolved: ResolvedTools): Capability[] {
   return REQUIRED.filter((capability) => resolved.name(capability) === null);
}
