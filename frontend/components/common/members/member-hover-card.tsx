'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { loadMemberTopAgents, type TopAgent } from '@/lib/workspaces';

/**
 * What a member's name reveals when you rest on it.
 *
 * Three facts, chosen because they are the three worth interrupting a page
 * for: who they are, what they may do here, and which agents keep turning up
 * on their work. The last is the one nowhere else answers — an agent list is
 * per-workspace, and "whose agents are these" is not a question the agents
 * page can ask.
 *
 * Built on Popover rather than a hover-card primitive, which Berry does not
 * ship, with the open state driven by pointer enter and leave. A short delay
 * before opening keeps it from firing at every name a cursor crosses on its
 * way somewhere else, and the fetch happens only once it has actually opened,
 * so passing over a list of forty people costs nothing.
 */
export function MemberHoverCard({
   workspaceId,
   member,
   role,
   children,
}: {
   workspaceId: string;
   member: { userId: string; name: string; email: string; avatarUrl: string | null };
   role: string;
   children: React.ReactNode;
}) {
   const t = useTranslations('workspaceAdmin.hoverCard');
   const roles = useTranslations('workspaceAdmin.members');
   const [open, setOpen] = useState(false);
   const [agents, setAgents] = useState<TopAgent[] | null>(null);
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

   useEffect(() => {
      if (!open || agents !== null || !workspaceId) return;
      let cancelled = false;
      void loadMemberTopAgents(workspaceId, member.userId)
         .then((found) => {
            if (!cancelled) setAgents(found.slice(0, 2));
         })
         .catch(() => {
            if (!cancelled) setAgents([]);
         });
      return () => {
         cancelled = true;
      };
   }, [open, agents, workspaceId, member.userId]);

   const schedule = (next: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(next), next ? 350 : 120);
   };

   useEffect(
      () => () => {
         if (timer.current) clearTimeout(timer.current);
      },
      []
   );

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverAnchor asChild>
            <span
               onPointerEnter={() => schedule(true)}
               onPointerLeave={() => schedule(false)}
               onFocus={() => setOpen(true)}
               onBlur={() => setOpen(false)}
            >
               {children}
            </span>
         </PopoverAnchor>
         <PopoverContent
            align="start"
            className="w-72"
            onPointerEnter={() => schedule(true)}
            onPointerLeave={() => schedule(false)}
         >
            <div className="flex items-center gap-3">
               <Avatar className="size-9">
                  <AvatarImage src={member.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback>{member.name[0] ?? '·'}</AvatarFallback>
               </Avatar>
               <div className="min-w-0">
                  <div className="truncate font-medium">{member.name}</div>
                  <div className="truncate text-muted-foreground">{member.email}</div>
               </div>
            </div>
            <div className="mt-3 text-muted-foreground">{roles(roleKey(role))}</div>
            <div className="mt-3 border-t pt-3">
               <div className="text-muted-foreground">{t('topAgents')}</div>
               {agents === null ? (
                  <p className="mt-1 text-muted-foreground">{t('loading')}</p>
               ) : agents.length === 0 ? (
                  <p className="mt-1 text-muted-foreground">{t('noAgents')}</p>
               ) : (
                  <ul className="mt-1 flex flex-col gap-0.5">
                     {agents.map((agent) => (
                        <li key={agent.agentId} className="flex items-center justify-between gap-2">
                           <span className="truncate">{agent.name}</span>
                           <span className="shrink-0 text-muted-foreground">
                              {t('runs', { count: agent.runCount })}
                           </span>
                        </li>
                     ))}
                  </ul>
               )}
            </div>
         </PopoverContent>
      </Popover>
   );
}

/** The message key naming a role; an unknown value reads as member. */
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
