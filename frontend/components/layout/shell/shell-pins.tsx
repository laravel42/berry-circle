'use client';

import { loadPins, type Pin } from '@/lib/pins';
import { usePinsStore } from '@/store/pins-store';
import { useSessionStore } from '@/store/session-store';
import Link from 'next/link';
import { useEffect } from 'react';

function hrefFor(orgId: string, pin: Pin): string {
   if (pin.targetType === 'issue') return `/${orgId}/issue/${pin.identifier ?? pin.targetId}`;
   if (pin.targetType === 'view') return `/${orgId}/view/${pin.targetId}`;
   return `/${orgId}/project/${pin.targetId}/overview`;
}

/** The rail's "pinned" section. Hidden when nothing is pinned. */
export function ShellPins({ orgId }: { orgId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, hydrate } = usePinsStore();

   useEffect(() => {
      if (!workspaceId) return;
      void loadPins(workspaceId)
         .then(hydrate)
         .catch(() => undefined);
   }, [workspaceId, hydrate]);

   if (pins.length === 0) return null;
   return (
      <div>
         <div className="px-[18px] pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">pinned</div>
         <ul className="flex flex-col gap-px px-2">
            {pins.map((pin) => (
               <li key={pin.id}>
                  <Link
                     data-shell-nav
                     href={hrefFor(orgId, pin)}
                     className="flex items-center gap-2.5 truncate rounded px-2.5 py-1.5 text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
                  >
                     {pin.identifier ? <span className="text-[var(--shell-text-dim)]">{pin.identifier}</span> : null}
                     <span className="truncate">{pin.title}</span>
                  </Link>
               </li>
            ))}
         </ul>
      </div>
   );
}
