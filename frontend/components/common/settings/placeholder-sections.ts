/** Config of the generic settings pages that don't have a dedicated UI yet. */
export interface PlaceholderConfig {
   title: string;
   description?: string;
   actionLabel?: string;
   emptyLabel: string;
}

export const PLACEHOLDER_SECTIONS: Record<string, PlaceholderConfig> = {
   'agent-personalization': {
      title: 'Agent personalization',
      description:
         'Personal guidance for the agents you work with. Berry stores an agent\u2019s instructions for the whole workspace; there is nowhere yet for yours alone.',
      emptyLabel: 'Not built yet',
   },
   'code-and-reviews': {
      title: 'Code & reviews',
      description:
         'Preferences for reading a diff inside Berry. The run\u2019s branch and pull request are shown on the run itself; nothing here is stored yet.',
      emptyLabel: 'Not built yet',
   },
   'issue-templates': {
      title: 'Task templates',
      description:
         'Prefilled tasks a person can start from. Berry has no template store yet, so nothing here would survive a reload.',
      emptyLabel: 'No task templates',
   },
   slas: {
      title: 'SLAs',
      description: 'Automatically apply deadlines to tasks based on their properties',
      actionLabel: 'New SLA',
      emptyLabel: 'No SLAs',
   },
   'project-labels': {
      title: 'Project labels',
      actionLabel: 'New label',
      emptyLabel: 'No project labels',
   },
   'project-templates': {
      title: 'Project templates',
      actionLabel: 'New template',
      emptyLabel: 'No project templates',
   },
   'project-updates': {
      title: 'Project updates',
      description: 'Configure how project updates are collected across the workspace',
      emptyLabel: 'No updates',
   },
   initiatives: {
      title: 'Initiatives',
      description: 'Group projects into larger bodies of work',
      actionLabel: 'New initiative',
      emptyLabel: 'No initiatives',
   },
   documents: {
      title: 'Documents',
      actionLabel: 'New document',
      emptyLabel: 'No documents',
   },
   'customer-requests': {
      title: 'Customer requests',
      description: 'Track and manage customer requests alongside your team’s work',
      actionLabel: 'New request',
      emptyLabel: 'No customer requests',
   },
   releases: {
      title: 'Releases',
      actionLabel: 'New release',
      emptyLabel: 'No releases',
   },
   pulse: {
      title: 'Pulse',
      description: 'A feed of important updates across your workspace',
      emptyLabel: 'No updates',
   },
   asks: {
      title: 'Asks',
      description: 'Turn requests into actionable tasks',
      actionLabel: 'New Ask',
      emptyLabel: 'No asks',
   },
   emojis: {
      title: 'Emojis',
      actionLabel: 'Upload',
      emptyLabel: 'No emojis',
   },
};
