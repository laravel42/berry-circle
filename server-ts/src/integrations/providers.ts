/**
 * What Berry can connect to, and what each connection lets an agent do.
 *
 * The catalogue is code rather than a table because it describes what *this
 * build* implements. A row saying Berry speaks Slack would not make it true,
 * and a deployment that added one would get a provider whose Connect button
 * leads nowhere.
 *
 * Two things are separate on purpose:
 *
 *   - **Configured** — the deployment holds OAuth credentials for it. Without
 *     them Connect cannot work, and the catalogue says so rather than offering
 *     a button that fails.
 *   - **Connected** — this workspace has actually authorised it.
 *
 * Berry's own provider is neither: its tools run inside the product, so there
 * is nothing to configure and nothing to connect.
 */

export type ToolEffect = 'read' | 'write' | 'external_side_effect' | 'destructive';

export interface ProviderTool {
   name: string;
   description: string;
   effect: ToolEffect;
   /** Whether reaching for it needs a person to say yes first. */
   requiresApproval: boolean;
   enabledByDefault: boolean;
}

export interface ProviderDefinition {
   id: string;
   name: string;
   description: string;
   /** The scopes Berry asks for. Shown before Connect, not after. */
   scopes: string[];
   tools: ProviderTool[];
}

/** Berry's own provider: its tools run inside the product and need no connection. */
export const BUILT_IN_PROVIDER = 'berry';

export const PROVIDERS: readonly ProviderDefinition[] = [
   {
      id: BUILT_IN_PROVIDER,
      name: 'Berry',
      description: 'The workspace itself: tasks, comments and the run ledger.',
      scopes: [],
      tools: [
         {
            name: 'berry.read_issue',
            description: 'Read a task, its description and its comments.',
            effect: 'read',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'berry.comment',
            description: 'Post a comment on the task being worked.',
            effect: 'write',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'berry.run_command',
            description: "Run a shell command in the run's isolated workspace.",
            effect: 'write',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'berry.write_artifact',
            description: 'Record a file as evidence on the run.',
            effect: 'write',
            requiresApproval: false,
            enabledByDefault: true,
         },
      ],
   },
   {
      id: 'github',
      name: 'GitHub',
      description: 'The repositories your agents check out, branch and open pull requests against.',
      // `repo` covers private repositories, which is the case a self-hosted
      // Berry is usually installed for. `read:org` is what makes the
      // repository picker able to show an organisation's repositories rather
      // than only the person's own.
      scopes: ['repo', 'read:org'],
      tools: [
         {
            name: 'github.read_repository',
            description: 'Clone the repository and read its files.',
            effect: 'read',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'github.create_branch',
            description: "Push a branch named for the task the agent is working.",
            effect: 'write',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'github.open_pull_request',
            description: 'Open a pull request for a person to review.',
            effect: 'external_side_effect',
            requiresApproval: false,
            enabledByDefault: true,
         },
         {
            name: 'github.merge_pull_request',
            description: 'Merge without waiting for a human review.',
            effect: 'destructive',
            // The review gate is the product. An agent reaching for this has
            // to be told yes by a person, every time.
            requiresApproval: true,
            enabledByDefault: false,
         },
      ],
   },
];

export function findProvider(id: string): ProviderDefinition | undefined {
   return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Whether a provider needs a connection at all.
 *
 * Berry's own does not, and treating it as unconnected would show a Connect
 * button for the product the person is already using.
 */
export function needsConnection(id: string): boolean {
   return id !== BUILT_IN_PROVIDER;
}
