'use client';

import { useParams } from 'next/navigation';

import ViewDetails from '@/components/common/views/view-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/view/header';

export default function ViewDrawerPage() {
   const { viewId } = useParams<{ orgId: string; viewId: string }>();

   return (
      <DetailDrawerShell header={<Header />}>
         <ViewDetails viewId={viewId} />
      </DetailDrawerShell>
   );
}
