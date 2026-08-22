import {
   Bot,
   GitPullRequestArrow,
   Inbox,
   FolderKanban,
   ContactRound,
   Box,
   Settings,
   Bell,
   KeyRound,
   Users,
   Tag,
   Layers,
   FileText,
   MessageSquare,
   Clock,
   Zap,
   UserRound,
} from 'lucide-react';

/**
 * Static sidebar navigation items. URLs use the default workspace slug
 * (`berry`) — kept in sync with the redirect targets in `app/page.tsx`.
 */
const ORG = 'berry';

export const inboxItems = [
   {
      name: 'Inbox',
      url: `/${ORG}/inbox`,
      icon: Inbox,
   },
   {
      name: 'Reviews',
      url: `/${ORG}/reviews`,
      icon: GitPullRequestArrow,
   },
   {
      name: 'My issues',
      url: `/${ORG}/my-issues`,
      icon: FolderKanban,
   },
   {
      name: 'Agent',
      url: `/${ORG}/agent`,
      icon: Bot,
   },
];

export const workspaceItems = [
   {
      name: 'Teams',
      url: `/${ORG}/teams`,
      icon: ContactRound,
   },
   {
      name: 'Projects',
      url: `/${ORG}/projects`,
      icon: Box,
   },
   {
      name: 'Members',
      url: `/${ORG}/members`,
      icon: UserRound,
   },
];

export const accountItems = [
   {
      name: 'Account',
      url: '/settings/account',
      icon: UserRound,
   },
   {
      name: 'Preferences',
      url: '/settings/preferences',
      icon: Settings,
   },
   {
      name: 'Profile',
      url: '/settings/profile',
      icon: UserRound,
   },
   {
      name: 'Notifications',
      url: '/settings/notifications',
      icon: Bell,
   },
   {
      name: 'Security & access',
      url: '/settings/security',
      icon: KeyRound,
   },
   {
      name: 'Connected accounts',
      url: '/settings/connected-accounts',
      icon: Users,
   },
];

export const featuresItems = [
   {
      name: 'Labels',
      url: '/settings/labels',
      icon: Tag,
   },
   {
      name: 'Projects',
      url: '/settings/projects',
      icon: Box,
   },
   {
      name: 'Initiatives',
      url: '/settings/initiatives',
      icon: Layers,
   },
   {
      name: 'Customer requests',
      url: '/settings/customer-requests',
      icon: Inbox,
   },
   {
      name: 'Templates',
      url: '/settings/templates',
      icon: FileText,
   },
   {
      name: 'Asks',
      url: '/settings/asks',
      icon: MessageSquare,
   },
   {
      name: 'SLAs',
      url: '/settings/slas',
      icon: Clock,
   },
   {
      name: 'Emojis',
      url: '/settings/emojis',
      icon: MessageSquare,
   },
   {
      name: 'Integrations',
      url: '/settings/integrations',
      icon: Zap,
   },
];
