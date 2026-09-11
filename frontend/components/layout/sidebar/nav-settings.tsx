import {
   Bell,
   Blocks,
   Building2,
   Columns3,
   FolderGit2,
   KeyRound,
   Link2,
   ListChecks,
   LucideIcon,
   Plug,
   Puzzle,
   Server,
   Settings,
   Sparkles,
   Tag,
   UserRound,
   Users,
   Zap,
} from 'lucide-react';

export type SettingsGroupKey = 'personal' | 'workspace' | 'issueConfig' | 'connections';

interface SettingsNavItem {
   /** Key under `workspaceAdmin.nav` in the message catalogues. */
   labelKey: string;
   /** Path under /{orgId}. */
   url: string;
   icon: LucideIcon;
}

interface SettingsNavGroup {
   /** Key under `workspaceAdmin.groups`. */
   labelKey: SettingsGroupKey;
   items: SettingsNavItem[];
}

/**
 * Settings navigation, rendered by the rail in settings mode and by the
 * narrow-screen dropdown in the settings header.
 *
 * Four groups, because the four answer different questions: what is true of
 * *me* (personal), what is true of *this workspace* (workspace), what a *task*
 * can carry (issue config), and what Berry is *attached to* (connections). The
 * earlier two-group split put task fields, MCP servers and repositories in one
 * undifferentiated "workspace" list, where the only way to find anything was to
 * read all eleven entries.
 *
 * Only pages with a backend are listed. A workstream that ships a settings page
 * appends its item here in the same change; a page with nothing behind it is
 * not listed and not built.
 */
export const settingsNav: SettingsNavGroup[] = [
   {
      labelKey: 'personal',
      items: [
         { labelKey: 'profile', url: '/settings/profile', icon: UserRound },
         { labelKey: 'preferences', url: '/settings/preferences', icon: Settings },
         { labelKey: 'notifications', url: '/settings/notifications', icon: Bell },
         { labelKey: 'security', url: '/settings/security', icon: KeyRound },
         { labelKey: 'connectedAccounts', url: '/settings/connected-accounts', icon: Users },
      ],
   },
   {
      labelKey: 'workspace',
      items: [
         { labelKey: 'general', url: '/settings/general', icon: Building2 },
         { labelKey: 'agents', url: '/settings/ai', icon: Sparkles },
         { labelKey: 'runtimes', url: '/runtimes', icon: Server },
         { labelKey: 'joinLinks', url: '/settings/join-links', icon: Link2 },
      ],
   },
   {
      labelKey: 'issueConfig',
      items: [
         { labelKey: 'statuses', url: '/settings/project-statuses', icon: Columns3 },
         { labelKey: 'labels', url: '/settings/issue-labels', icon: Tag },
         { labelKey: 'properties', url: '/settings/issue-properties', icon: ListChecks },
         { labelKey: 'quickActions', url: '/settings/quick-actions', icon: Zap },
      ],
   },
   {
      labelKey: 'connections',
      items: [
         { labelKey: 'repositories', url: '/settings/repositories', icon: FolderGit2 },
         { labelKey: 'integrations', url: '/settings/integrations', icon: Blocks },
         { labelKey: 'mcp', url: '/settings/mcp', icon: Plug },
         { labelKey: 'plugins', url: '/settings/plugins', icon: Puzzle },
      ],
   },
];
