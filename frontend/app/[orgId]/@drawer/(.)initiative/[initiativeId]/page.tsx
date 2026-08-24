'use client';

import { useParams } from 'next/navigation';

import InitiativeDetails from '@/components/common/initiatives/initiative-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/initiative/header';

export default function InitiativeDrawerPage() {
   const { initiativeId } = useParams<{ orgId: string; initiativeId: string }>();

   return (
      <DetailDrawerShell header={<Header />}>
         <InitiativeDetails initiativeId={initiativeId} />
      </DetailDrawerShell>
   );
}
