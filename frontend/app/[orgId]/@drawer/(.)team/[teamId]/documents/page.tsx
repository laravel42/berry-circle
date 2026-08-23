'use client';

import { useParams } from 'next/navigation';

import TeamDocuments from '@/components/common/teams/team-documents';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import CrewDetailHeader from '@/components/layout/headers/team/detail-header';

export default function CrewDocumentsDrawerPage() {
   const { teamId } = useParams<{ orgId: string; teamId: string }>();

   return (
      <DetailDrawerShell header={<CrewDetailHeader teamId={teamId} />}>
         <div className="min-h-0 flex-1 overflow-y-auto">
            <TeamDocuments />
         </div>
      </DetailDrawerShell>
   );
}
