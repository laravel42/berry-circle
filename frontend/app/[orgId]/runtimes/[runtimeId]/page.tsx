'use client';

import RuntimeDetail from '@/components/common/runtimes/runtime-detail';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';
import { useParams } from 'next/navigation';

// Read from the route on the client, as the agent detail page does.
export default function Page() {
   const { runtimeId } = useParams<{ orgId: string; runtimeId: string }>();
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <RuntimeDetail runtimeId={runtimeId} />
      </MainLayout>
   );
}
