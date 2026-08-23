'use client';

import { useParams } from 'next/navigation';

import MemberProfile from '@/components/common/members/member-profile';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/profile/header';
import { users } from '@/data/users';

export default function MemberDrawerPage() {
   const { memberId } = useParams<{ orgId: string; memberId: string }>();
   const member = users.find((user) => user.id === memberId);

   if (!member) {
      return null;
   }

   return (
      <DetailDrawerShell header={<Header member={member} />}>
         <MemberProfile member={member} />
      </DetailDrawerShell>
   );
}
