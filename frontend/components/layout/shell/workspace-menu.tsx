'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { toast } from 'sonner';

import { useSignOut } from '@/components/auth/use-sign-out';
import { BerryMark } from '@/components/brand/berry-mark';
import {
   DropdownMenuGroup,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuPortal,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { loadInboxUnreadCount } from '@/lib/inbox';
import {
   declineInvitation,
   joinInvitation,
   loadPendingInvitations,
   type PendingInvitation,
} from '@/lib/invitations';
import { useSessionStore } from '@/store/session-store';

/**
 * Contents of the workspace menu behind the brand.
 *
 * Extracted so the shell rail and the legacy sidebar's OrgSwitcher render one
 * definition. Two copies of a menu drift, and the drift is invisible until
 * someone notices an action missing from one of them.
 *
 * Everything here reads the live session (the persisted active workspace and
 * the user's full membership list), so the menu reflects what the account can
 * actually see rather than the build-time `WORKSPACE_NAME`. `WORKSPACE_NAME`
 * remains only as the label before the session is ready.
 *
 * Two things are loaded when the menu is rendered rather than kept in a store:
 * the unread count of the workspaces you are *not* in right now, and the
 * invitations waiting for you. Both are only ever looked at here, and both are
 * the kind of fact that should be fetched when someone asks rather than polled
 * behind their back.
 */
export function WorkspaceMenuItems({ orgId }: { orgId?: string }) {
   const router = useRouter();
   const t = useTranslations('navigation.workspaces');
   const active = useSessionStore((state) => state.workspace);
   const workspaces = useSessionStore((state) => state.workspaces);
   const switchWorkspace = useSessionStore((state) => state.switchWorkspace);
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);
   const { signOut, pending } = useSignOut();

   const [unread, setUnread] = useState<Record<string, number>>({});
   const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
   const [busyInvitation, setBusyInvitation] = useState<string | null>(null);

   // The slug that scopes settings/route links: the active workspace, the route
   // param, then the build-time default, in that order of trust.
   const slug = active?.slug || orgId || WORKSPACE_SLUG;
   const activeName = active?.name ?? WORKSPACE_NAME;

   // A dot only ever marks a workspace you are not looking at: the one you are
   // in already has the inbox badge in the rail, and two counts for one place
   // is one too many.
   useEffect(() => {
      let cancelled = false;
      const others = workspaces.filter((workspace) => workspace.id !== active?.id);
      if (others.length === 0) return;
      void Promise.all(
         others.map(
            async (workspace) => [workspace.id, await loadInboxUnreadCount(workspace.id)] as const
         )
      ).then((entries) => {
         if (!cancelled) setUnread(Object.fromEntries(entries));
      });
      return () => {
         cancelled = true;
      };
   }, [workspaces, active?.id]);

   useEffect(() => {
      let cancelled = false;
      void loadPendingInvitations().then((found) => {
         if (!cancelled) setInvitations(found);
      });
      return () => {
         cancelled = true;
      };
   }, []);

   const onSwitch = async (workspaceId: string) => {
      const next = await switchWorkspace(workspaceId);
      if (next) router.push(`/${next.slug}/tasks`);
   };

   const onJoin = async (invitation: PendingInvitation) => {
      setBusyInvitation(invitation.id);
      try {
         await joinInvitation(invitation.id);
         setInvitations((current) => current.filter((entry) => entry.id !== invitation.id));
         toast.success(t('joined', { name: invitation.workspaceName }));
         // The membership list is stale the moment the join succeeds, and the
         // person's next click is almost certainly "take me there".
         await refreshWorkspaces();
         await onSwitch(invitation.workspaceId);
      } catch {
         toast.error(t('joinFailed'));
      } finally {
         setBusyInvitation(null);
      }
   };

   const onDecline = async (invitation: PendingInvitation) => {
      setBusyInvitation(invitation.id);
      try {
         await declineInvitation(invitation.id);
         setInvitations((current) => current.filter((entry) => entry.id !== invitation.id));
         toast.success(t('declined'));
      } catch {
         toast.error(t('declineFailed'));
      } finally {
         setBusyInvitation(null);
      }
   };

   return (
      <>
         <DropdownMenuGroup>
            <DropdownMenuItem asChild>
               <Link href={`/${slug}/settings`}>
                  settings
                  <DropdownMenuShortcut>G then S</DropdownMenuShortcut>
               </Link>
            </DropdownMenuItem>
         </DropdownMenuGroup>
         <DropdownMenuSeparator />
         <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('switch')}</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
               <DropdownMenuSubContent>
                  <DropdownMenuLabel>{activeName}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {workspaces.length > 0 ? (
                     workspaces.map((workspace) => {
                        const isActive = workspace.id === active?.id;
                        const hasUnread = !isActive && (unread[workspace.id] ?? 0) > 0;
                        return (
                           <DropdownMenuItem
                              key={workspace.id}
                              disabled={isActive}
                              onSelect={(event) => {
                                 event.preventDefault();
                                 void onSwitch(workspace.id);
                              }}
                           >
                              <BerryMark size="sm" />
                              <span className="truncate">{workspace.name}</span>
                              {hasUnread ? (
                                 <span
                                    aria-label={t('unreadItems', { name: workspace.name })}
                                    title={t('unreadItems', { name: workspace.name })}
                                    className="ml-auto size-1.5 rounded-full bg-[var(--brand-berry)]"
                                 />
                              ) : null}
                              {isActive ? (
                                 <Check className="ml-auto size-4" aria-hidden="true" />
                              ) : null}
                           </DropdownMenuItem>
                        );
                     })
                  ) : (
                     <DropdownMenuItem disabled>{t('none')}</DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                     <Link href="/workspaces/new">{t('create')}</Link>
                  </DropdownMenuItem>
               </DropdownMenuSubContent>
            </DropdownMenuPortal>
         </DropdownMenuSub>

         {invitations.length > 0 ? (
            <>
               <DropdownMenuSeparator />
               <DropdownMenuLabel>{t('invitations')}</DropdownMenuLabel>
               {invitations.map((invitation) => (
                  <div
                     key={invitation.id}
                     className="flex items-center gap-2 px-2 py-1.5"
                     // Not a menu item: it holds two actions, and a row that
                     // does something when you press Enter on it could do
                     // either one.
                  >
                     <span className="min-w-0 flex-1 truncate">
                        {t('invitedTo', { name: invitation.workspaceName })}
                     </span>
                     <button
                        type="button"
                        disabled={busyInvitation === invitation.id}
                        onClick={() => void onJoin(invitation)}
                        className="rounded bg-primary px-2 py-0.5 text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                     >
                        {t('join')}
                     </button>
                     <button
                        type="button"
                        disabled={busyInvitation === invitation.id}
                        onClick={() => void onDecline(invitation)}
                        className="rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                     >
                        {t('decline')}
                     </button>
                  </div>
               ))}
            </>
         ) : null}

         <DropdownMenuSeparator />
         <DropdownMenuItem
            disabled={pending}
            onSelect={(event) => {
               event.preventDefault();
               void signOut();
            }}
         >
            {t('logOut')}
            <DropdownMenuShortcut>⌥⇧Q</DropdownMenuShortcut>
         </DropdownMenuItem>
      </>
   );
}
