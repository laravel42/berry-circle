'use client';

import { useParams } from 'next/navigation';

import ProjectIssues from '@/components/common/projects/details/project-issues';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/project/header';

export default function ProjectIssuesDrawerPage() {
   const { projectId } = useParams<{ orgId: string; projectId: string }>();

   return (
      <DetailDrawerShell header={<Header projectId={projectId} />}>
         <ProjectIssues projectId={projectId} />
      </DetailDrawerShell>
   );
}
