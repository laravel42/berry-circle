'use client';

import { format, parseISO } from 'date-fns';
import { Copy, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SettingsCard, SettingsRow, SettingsSection } from '@/components/common/settings/shared';
import { useSettingsResource } from '@/components/common/settings/use-settings-resource';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { BerryApiError } from '@/lib/api';
import {
   createWorkspaceInvitation,
   listWorkspaceInvitations,
   listWorkspaceMemberRoles,
   removeMember,
   revokeWorkspaceInvitation,
   updateMemberRole,
   WORKSPACE_ROLES,
   type WorkspaceInvitation,
   type WorkspaceMemberRole,
   type WorkspaceRole,
} from '@/lib/workspaces';
import { cn } from '@/lib/utils';
import { useMembersFilterStore } from '@/store/members-filter-store';
import { useSessionStore } from '@/store/session-store';

/** Roles an invitation may carry. The server refuses `owner` outright. */
const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;

const ROLE_STYLE: Record<WorkspaceRole, string> = {
   owner: 'border-primary/40 bg-primary/10 text-primary',
   admin: 'border-status-info/40 bg-status-info/10 text-status-info',
   member: 'border-border text-muted-foreground',
   viewer: 'border-border text-muted-foreground',
};

/**
 * The message key naming a role.
 *
 * An invitation's role arrives as a plain string, so a key built from it by
 * interpolation is not provably a message that exists. Mapping the four
 * explicitly makes it one, and an unrecognised value renders a sensible label
 * rather than surfacing a missing-key error to the reader.
 */
function roleKey(role: string): 'role_owner' | 'role_admin' | 'role_member' | 'role_viewer' {
   switch (role) {
      case 'owner':
         return 'role_owner';
      case 'admin':
         return 'role_admin';
      case 'viewer':
         return 'role_viewer';
      default:
         return 'role_member';
   }
}

/**
 * Workspace members: who is here, what they may do, and who has been asked.
 *
 * The list this replaced came from the imported template and was largely
 * theatre — it showed a quarter of members by email for no reason, printed a
 * joined date against a hard-coded year, rendered an "Application" role the
 * server never returns, and collapsed owner and viewer into "Member", so the
 * two roles that decide who can administer a workspace were invisible.
 *
 * What the server enforces, this page reflects rather than re-implements:
 * only an owner may grant or touch owner and admin, and the last owner can
 * neither be demoted nor removed. Those controls are disabled with the reason
 * shown, so nobody discovers the rule by being refused.
 *
 * Berry sends no mail, so an invitation's token is shown once, here, and the
 * page says plainly that it is the only copy.
 */
export default function Members() {
   const t = useTranslations('workspaceAdmin.members');
   const { orgId } = useParams<{ orgId: string }>();
   const { filters, sort } = useMembersFilterStore();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const myId = useSessionStore((state) => state.user?.id ?? '');

   const members = useSettingsResource<WorkspaceMemberRole[]>(
      () =>
         workspaceId
            ? listWorkspaceMemberRoles(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const me = (members.value ?? []).find((member) => member.userId === myId);
   const iAmOwner = me?.role === 'owner';
   const canManage = iAmOwner || me?.role === 'admin';
   const owners = (members.value ?? []).filter((member) => member.role === 'owner');

   // Invitations need `invitations.read`, which a plain member does not have —
   // asking anyway would put a 403 on the page for someone who simply cannot
   // be shown this section.
   const invitations = useSettingsResource<WorkspaceInvitation[]>(
      () =>
         workspaceId && canManage
            ? listWorkspaceInvitations(workspaceId)
            : Promise.resolve<WorkspaceInvitation[]>([]),
      [workspaceId, canManage]
   );

   // "Updates live", as far as a page without a subscription honestly can:
   // whenever this tab is looked at again, both lists are re-read. A role
   // changed in another tab or by someone else is then correct here.
   const reload = useCallback(() => {
      members.reload();
      invitations.reload();
      // The resource's reload is a stable bump of its own nonce.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);
   useEffect(() => {
      const onFocus = () => {
         if (document.visibilityState === 'visible') reload();
      };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onFocus);
      return () => {
         window.removeEventListener('focus', onFocus);
         document.removeEventListener('visibilitychange', onFocus);
      };
   }, [reload]);

   const displayed = useMemo(() => {
      const list = (members.value ?? []).filter(
         (member) =>
            filters.role.length === 0 || filters.role.includes(member.role as WorkspaceRole)
      );
      return list.sort((a, b) => {
         switch (sort) {
            case 'name-desc':
               return b.name.localeCompare(a.name);
            case 'joined-asc':
               return a.joinedAt.localeCompare(b.joinedAt);
            case 'joined-desc':
               return b.joinedAt.localeCompare(a.joinedAt);
            default:
               return a.name.localeCompare(b.name);
         }
      });
   }, [members.value, filters.role, sort]);

   // ------------------------------------------------------------------ invite

   const [inviting, setInviting] = useState(false);
   const [sending, setSending] = useState(false);
   const [email, setEmail] = useState('');
   const [inviteRole, setInviteRole] = useState<(typeof INVITE_ROLES)[number]>('member');
   /** Shown once: the server keeps only a hash of the token. */
   const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);

   const invite = async () => {
      setSending(true);
      try {
         const { invitation, token } = await createWorkspaceInvitation(workspaceId, {
            email: email.trim().toLowerCase(),
            role: inviteRole,
         });
         setInviting(false);
         setEmail('');
         invitations.reload();
         if (token) setIssued({ id: invitation.id, token });
         else toast.success(t('inviteSent'));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('inviteFailed'));
      } finally {
         setSending(false);
      }
   };

   const inviteLink = issued
      ? `${window.location.origin}/invite/${issued.id}?token=${encodeURIComponent(issued.token)}`
      : '';

   // ------------------------------------------------------- roles and removal

   const [busy, setBusy] = useState<string | null>(null);
   const [removing, setRemoving] = useState<WorkspaceMemberRole | null>(null);

   const changeRole = async (member: WorkspaceMemberRole, role: WorkspaceRole) => {
      setBusy(member.userId);
      try {
         await updateMemberRole(workspaceId, member.userId, role);
         members.reload();
      } catch (cause) {
         toast.error(
            cause instanceof BerryApiError && cause.status === 409
               ? t('lastOwner')
               : cause instanceof Error
                 ? cause.message
                 : t('roleFailed')
         );
      } finally {
         setBusy(null);
      }
   };

   const confirmRemove = async () => {
      if (!removing) return;
      setBusy(removing.userId);
      try {
         await removeMember(workspaceId, removing.userId);
         setRemoving(null);
         members.reload();
      } catch (cause) {
         toast.error(
            cause instanceof BerryApiError && cause.status === 409
               ? t('lastOwner')
               : cause instanceof Error
                 ? cause.message
                 : t('removeFailed')
         );
      } finally {
         setBusy(null);
      }
   };

   /** Why this member's role cannot be changed, or null when it can. */
   const lockedReason = (member: WorkspaceMemberRole): string | null => {
      if (!canManage) return null;
      if (member.role === 'owner' && owners.length === 1) return t('lastOwner');
      if (!iAmOwner && (member.role === 'owner' || member.role === 'admin')) return t('ownerOnly');
      return null;
   };

   const pending = (invitations.value ?? []).filter(
      (invitation) => !invitation.acceptedAt && !invitation.revokedAt
   );

   return (
      <div className="h-full w-full overflow-y-auto">
         <div className="mx-auto max-w-3xl px-6 py-8 pb-20">
            <SettingsSection
               title={t('title')}
               description={members.error ?? undefined}
               action={
                  canManage ? (
                     <Button size="xs" onClick={() => setInviting(true)}>
                        <Plus className="size-4" />
                        {t('invite')}
                     </Button>
                  ) : null
               }
            >
               <SettingsCard>
                  {members.loading ? <SettingsRow title={t('loading')} /> : null}
                  {!members.loading && displayed.length === 0 ? (
                     <SettingsRow title={t('empty')} />
                  ) : null}
                  {displayed.map((member) => {
                     const locked = lockedReason(member);
                     const role = member.role as WorkspaceRole;
                     return (
                        <SettingsRow
                           key={member.userId}
                           icon={
                              <Avatar className="size-8">
                                 <AvatarImage src={member.avatarUrl ?? undefined} alt="" />
                                 <AvatarFallback>{member.name[0] ?? '·'}</AvatarFallback>
                              </Avatar>
                           }
                           title={
                              <Link
                                 href={`/${orgId}/members/${member.userId}`}
                                 className="hover:underline"
                              >
                                 {member.name}
                                 {member.userId === myId ? (
                                    <span className="ml-1.5 text-muted-foreground">{t('you')}</span>
                                 ) : null}
                              </Link>
                           }
                           description={[
                              member.email,
                              t('joined', {
                                 when: format(parseISO(member.joinedAt), 'd MMM yyyy'),
                              }),
                              locked,
                           ]
                              .filter(Boolean)
                              .join(' · ')}
                           trailing={
                              <span className="flex items-center gap-2">
                                 {canManage && !locked ? (
                                    <Select
                                       value={role}
                                       disabled={busy === member.userId}
                                       onValueChange={(next) =>
                                          void changeRole(member, next as WorkspaceRole)
                                       }
                                    >
                                       <SelectTrigger
                                          className="h-7 w-28"
                                          aria-label={t('roleFor', { name: member.name })}
                                       >
                                          <SelectValue />
                                       </SelectTrigger>
                                       <SelectContent>
                                          {WORKSPACE_ROLES.filter(
                                             // Only an owner may hand out owner.
                                             (candidate) => candidate !== 'owner' || iAmOwner
                                          ).map((candidate) => (
                                             <SelectItem key={candidate} value={candidate}>
                                                {t(`role_${candidate}`)}
                                             </SelectItem>
                                          ))}
                                       </SelectContent>
                                    </Select>
                                 ) : (
                                    <span
                                       className={cn(
                                          'inline-flex items-center rounded-md border px-1.5 py-0.5',
                                          ROLE_STYLE[role] ?? ROLE_STYLE.member
                                       )}
                                    >
                                       {t(`role_${role}`)}
                                    </span>
                                 )}
                                 {canManage && !locked && member.userId !== myId ? (
                                    <Button
                                       size="xs"
                                       variant="ghost"
                                       className="text-status-danger hover:text-status-danger"
                                       disabled={busy === member.userId}
                                       onClick={() => setRemoving(member)}
                                    >
                                       {t('remove')}
                                    </Button>
                                 ) : null}
                              </span>
                           }
                        />
                     );
                  })}
               </SettingsCard>
            </SettingsSection>

            {canManage ? (
               <div className="mt-10">
                  <SettingsSection
                     title={t('pending')}
                     description={invitations.error ?? t('pendingDescription')}
                  >
                     <SettingsCard>
                        {pending.length === 0 ? <SettingsRow title={t('pendingEmpty')} /> : null}
                        {pending.map((invitation) => {
                           const expired = new Date(invitation.expiresAt) < new Date();
                           return (
                              <SettingsRow
                                 key={invitation.id}
                                 title={invitation.email}
                                 muted={expired}
                                 description={[
                                    t(roleKey(invitation.role)),
                                    expired
                                       ? t('expired')
                                       : t('expires', {
                                            when: format(
                                               parseISO(invitation.expiresAt),
                                               'd MMM yyyy'
                                            ),
                                         }),
                                 ].join(' · ')}
                                 trailing={
                                    <Button
                                       size="xs"
                                       variant="ghost"
                                       className="text-status-danger hover:text-status-danger"
                                       onClick={() =>
                                          void revokeWorkspaceInvitation(workspaceId, invitation.id)
                                             .then(() => invitations.reload())
                                             .catch((cause: unknown) =>
                                                toast.error(
                                                   cause instanceof Error
                                                      ? cause.message
                                                      : t('revokeFailed')
                                                )
                                             )
                                       }
                                    >
                                       {t('revoke')}
                                    </Button>
                                 }
                              />
                           );
                        })}
                     </SettingsCard>
                  </SettingsSection>

                  <div className="mt-10">
                     <SettingsSection
                        title={t('joinLinks')}
                        description={t('joinLinksDescription')}
                     >
                        <SettingsCard>
                           <SettingsRow
                              title={t('joinLinksOpen')}
                              chevron
                              onClick={() => {
                                 window.location.href = `/${orgId}/settings/join-links`;
                              }}
                           />
                        </SettingsCard>
                     </SettingsSection>
                  </div>
               </div>
            ) : null}
         </div>

         <Dialog open={inviting} onOpenChange={(open) => !sending && setInviting(open)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('inviteTitle')}</DialogTitle>
                  <DialogDescription>{t('inviteDescription')}</DialogDescription>
               </DialogHeader>
               <div className="flex flex-col gap-3">
                  <Input
                     value={email}
                     type="email"
                     autoComplete="off"
                     aria-label={t('inviteEmail')}
                     placeholder="someone@example.com"
                     disabled={sending}
                     onChange={(event) => setEmail(event.target.value)}
                  />
                  <Select
                     value={inviteRole}
                     onValueChange={(next) => setInviteRole(next as (typeof INVITE_ROLES)[number])}
                  >
                     <SelectTrigger aria-label={t('inviteRole')}>
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {INVITE_ROLES.map((candidate) => (
                           <SelectItem key={candidate} value={candidate}>
                              {t(`role_${candidate}`)}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>
               <DialogFooter>
                  <Button variant="secondary" disabled={sending} onClick={() => setInviting(false)}>
                     {t('cancel')}
                  </Button>
                  <Button disabled={sending || email.trim() === ''} onClick={() => void invite()}>
                     {sending ? <Loader2 className="size-3.5 animate-spin" /> : t('inviteSend')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         {/* Berry sends no mail. This link is the invitation, and the server
             kept only a hash of it — so it is shown once and said so. */}
         <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('inviteTokenTitle')}</DialogTitle>
                  <DialogDescription>{t('inviteTokenBody')}</DialogDescription>
               </DialogHeader>
               <code className="block rounded-md border bg-container px-3 py-2 break-all font-mono text-muted-foreground">
                  {inviteLink}
               </code>
               <DialogFooter>
                  <Button
                     variant="secondary"
                     onClick={() => {
                        void navigator.clipboard?.writeText(inviteLink);
                        toast.success(t('copied'));
                     }}
                  >
                     <Copy className="size-4" />
                     {t('copy')}
                  </Button>
                  <Button onClick={() => setIssued(null)}>{t('done')}</Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('removeTitle')}</DialogTitle>
                  <DialogDescription>
                     {t('removeBody', { name: removing?.name ?? '' })}
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="secondary" onClick={() => setRemoving(null)}>
                     {t('cancel')}
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={busy !== null}
                     onClick={() => void confirmRemove()}
                  >
                     {t('removeAction')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </div>
   );
}
