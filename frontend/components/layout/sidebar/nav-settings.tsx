import {
   Bell,
   Blocks,
   Braces,
   Building2,
   Columns3,
   FolderGit2,
   Keyboard,
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
   UsersRound,
   Zap,
} from 'lucide-react';

export type SettingsGroupKey = 'personal' | 'workspace' | 'issueConfig' | 'connections';

/**
 * The keys under `workspaceAdmin.nav`, spelled out rather than left as
 * `string`.
 *
 * The rail and the header dropdown both render `nav.${labelKey}`, and only a
 * union makes that a message key the compiler can check — with `string`, a
 * typo here would ship and surface as a raw key in the navigation.
 */
export type SettingsNavKey =
   | 'profile'
   | 'preferences'
   | 'notifications'
   | 'shortcuts'
   | 'security'
   | 'tokens'
   | 'connectedAccounts'
   | 'general'
   | 'members'
   | 'agents'
   | 'runtimes'
   | 'joinLinks'
   | 'statuses'
   | 'labels'
   | 'properties'
   | 'quickActions'
   | 'repositories'
   | 'integrations'
   | 'mcp'
   | 'plugins';

interface SettingsNavItem {
   /** Key under `workspaceAdmin.nav` in the message catalogues. */
   labelKey: SettingsNavKey;
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
         { labelKey: 'shortcuts', url: '/settings/shortcuts', icon: Keyboard },
         { labelKey: 'security', url: '/settings/security', icon: KeyRound },
         { labelKey: 'tokens', url: '/settings/tokens', icon: Braces },
         { labelKey: 'connectedAccounts', url: '/settings/connected-accounts', icon: Users },
      ],
   },
   {
      labelKey: 'workspace',
      items: [
         { labelKey: 'general', url: '/settings/general', icon: Building2 },
         // Members is not under /settings: it is a workspace surface in its own
         // right, and the rail should reach the page people already bookmark.
         { labelKey: 'members', url: '/members', icon: UsersRound },
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
