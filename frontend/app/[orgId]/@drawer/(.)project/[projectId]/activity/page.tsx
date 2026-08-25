'use client';

import { useParams } from 'next/navigation';

import ProjectOverview from '@/components/common/projects/details/project-overview';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/project/header';

export default function ProjectActivityDrawerPage() {
   const { projectId } = useParams<{ orgId: string; projectId: string }>();

   return (
      <DetailDrawerShell header={<Header projectId={projectId} />}>
         <ProjectOverview projectId={projectId} />
      </DetailDrawerShell>
   );
}
