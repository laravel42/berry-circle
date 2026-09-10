import {
   Bell,
   Blocks,
   Columns3,
   KeyRound,
   LucideIcon,
   Settings,
   Sparkles,
   Tag,
   UserRound,
   Users,
} from 'lucide-react';

interface SettingsNavItem {
   name: string;
   /** Path under /{orgId}. */
   url: string;
   icon: LucideIcon;
}

interface SettingsNavGroup {
   label: string;
   items: SettingsNavItem[];
}

/**
 * Settings navigation, rendered by the rail in settings mode.
 *
 * Only pages with a backend are listed. A workstream that ships a settings
 * page appends its item here in the same change; a page with nothing behind
 * it is not listed and not built.
 */
export const settingsNav: SettingsNavGroup[] = [
   {
      label: 'personal',
      items: [
         { name: 'preferences', url: '/settings/preferences', icon: Settings },
         { name: 'profile', url: '/settings/profile', icon: UserRound },
         { name: 'notifications', url: '/settings/notifications', icon: Bell },
         { name: 'security & access', url: '/settings/security', icon: KeyRound },
         { name: 'connected accounts', url: '/settings/connected-accounts', icon: Users },
      ],
   },
   {
      label: 'workspace',
      items: [
         { name: 'agents', url: '/settings/ai', icon: Sparkles },
         { name: 'task labels', url: '/settings/issue-labels', icon: Tag },
         { name: 'statuses', url: '/settings/project-statuses', icon: Columns3 },
         { name: 'integrations', url: '/settings/integrations', icon: Blocks },
      ],
   },
];
