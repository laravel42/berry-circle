import type { ToolDefinition } from './gateway-client.ts';

/**
 * Berry's argument names, translated into the tool's own.
 *
 * The same problem as tool names, one level down: a gateway target built from
 * GitHub's OpenAPI calls the repository `repo`, one built from a Smithy model
 * may call it `repositoryName`, and a hand-written target may call it
 * `repository`. Sending the wrong key is a validation error at run time that
 * reads like a bug in Berry.
 *
 * So the tool's own `inputSchema` decides. Berry names a field canonically,
 * this finds the property the tool actually declares, and a field the tool
 * does not accept is dropped rather than sent — a tool that takes no `labels`
 * should not be handed one and refuse the whole call.
 */

/** What Berry calls a field, and every name a tool might use for it. */
const ALIASES: Record<string, string[]> = {
   owner: ['owner', 'org', 'organization', 'owner_name', 'ownerName', 'repositoryOwner'],
   repo: ['repo', 'repository', 'repo_name', 'repoName', 'repositoryName', 'name'],
   title: ['title', 'name', 'summary'],
   body: ['body', 'description', 'text'],
   issueNumber: ['issue_number', 'issueNumber', 'number', 'issue'],
   pullNumber: ['pull_number', 'pullNumber', 'number', 'pull_request_number'],
   milestoneNumber: ['milestone_number', 'milestoneNumber', 'milestone', 'number'],
   state: ['state', 'status'],
   labels: ['labels', 'label_names', 'labelNames'],
   assignees: ['assignees', 'assignee_names'],
   head: ['head', 'head_branch', 'headBranch', 'source_branch', 'from'],
   base: ['base', 'base_branch', 'baseBranch', 'target_branch', 'into'],
   dueOn: ['due_on', 'dueOn', 'due_date', 'dueDate'],
   private: ['private', 'is_private', 'visibility'],
   defaultBranch: ['default_branch', 'defaultBranch'],
   branch: ['branch', 'branch_name', 'branchName', 'ref'],
   sha: ['sha', 'commit_sha', 'commitSha', 'from_sha'],
   perPage: ['per_page', 'perPage', 'limit', 'maxResults'],
};

/**
 * The property names a tool declares.
 *
 * An empty schema means the tool declared nothing, and then nothing can be
 * dropped safely — so every field is sent and the tool decides.
 */
export function propertiesOf(tool: ToolDefinition | undefined): Set<string> | null {
   const schema = tool?.inputSchema;
   const properties = schema?.properties;
   if (!properties || typeof properties !== 'object') return null;
   const names = Object.keys(properties as Record<string, unknown>);
   return names.length === 0 ? null : new Set(names);
}

/**
 * Berry's fields as this tool's arguments.
 *
 * `undefined` values are omitted rather than sent as null: a PATCH that sends
 * every field it was not asked to change would overwrite whatever somebody had
 * set on GitHub, which is the loop this integration works hard to avoid.
 */
export function toolArguments(
   tool: ToolDefinition | undefined,
   fields: Record<string, unknown>
): Record<string, unknown> {
   const accepted = propertiesOf(tool);
   const args: Record<string, unknown> = {};

   for (const [canonical, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const key = resolveKey(canonical, accepted);
      // The tool declares a schema and has no property for this field: it does
      // not take it, and sending it anyway is how a whole call gets refused
      // for a field nobody needed.
      if (key === null) continue;
      args[key] = value;
   }
   return args;
}

function resolveKey(canonical: string, accepted: Set<string> | null): string | null {
   const aliases = ALIASES[canonical] ?? [canonical];
   if (!accepted) return aliases[0] ?? canonical;
   for (const alias of aliases) {
      if (accepted.has(alias)) return alias;
   }
   // Case-insensitively, because a schema may differ only in casing and
   // refusing over that would be pedantry with a run attached.
   const lower = new Map([...accepted].map((name) => [name.toLowerCase(), name]));
   for (const alias of aliases) {
      const match = lower.get(alias.toLowerCase());
      if (match) return match;
   }
   return null;
}

/**
 * A field from a tool's answer, whatever the host called it.
 *
 * The mirror of the above, and needed for the same reason: a response is as
 * much the target's shape as a request is.
 */
export function readField(payload: unknown, ...names: string[]): unknown {
   if (!payload || typeof payload !== 'object') return undefined;
   const record = payload as Record<string, unknown>;
   for (const name of names) {
      if (record[name] !== undefined) return record[name];
   }
   const lower = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
   for (const name of names) {
      const value = lower.get(name.toLowerCase());
      if (value !== undefined) return value;
   }
   return undefined;
}
