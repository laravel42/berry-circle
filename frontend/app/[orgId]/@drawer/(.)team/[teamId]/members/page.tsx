'use client';

import { useParams } from 'next/navigation';

import TeamMembers from '@/components/common/teams/team-members';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import CrewDetailHeader from '@/components/layout/headers/team/detail-header';

export default function CrewMembersDrawerPage() {
   const { teamId } = useParams<{ orgId: string; teamId: string }>();

   return (
      <DetailDrawerShell header={<CrewDetailHeader teamId={teamId} />}>
         <div className="min-h-0 flex-1 overflow-y-auto">
            <TeamMembers />
         </div>
      </DetailDrawerShell>
   );
}
