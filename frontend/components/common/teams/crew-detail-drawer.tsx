'use client';

import CrewDetails from '@/components/common/teams/details/crew-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import CrewDetailHeader from '@/components/layout/headers/team/detail-header';
import { useCrewDrawerStore } from '@/store/crew-drawer-store';
import { useEffect } from 'react';

/** Right-hand crew detail sheet opened from the crews list. */
export function CrewDetailDrawer() {
   const teamId = useCrewDrawerStore((state) => state.teamId);
   const close = useCrewDrawerStore((state) => state.close);

   useEffect(() => {
      return () => close();
   }, [close]);

   return (
      <DetailDrawerShell
         open={teamId !== null}
         onClose={close}
         header={teamId ? <CrewDetailHeader teamId={teamId} /> : undefined}
      >
         {teamId ? <CrewDetails teamId={teamId} /> : null}
      </DetailDrawerShell>
   );
}
