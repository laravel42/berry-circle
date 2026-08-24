'use client';

import IssueDetails from '@/components/common/issues/details/issue-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/issue/header';

export default function IssueDrawerPage() {
   return (
      <DetailDrawerShell header={<Header />}>
         <IssueDetails />
      </DetailDrawerShell>
   );
}
