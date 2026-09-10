'use client';

import { useParams } from 'next/navigation';

import MemberProfile from '@/components/common/members/member-profile';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/profile/header';
import { useMembersStore } from '@/store/members-store';

export default function MemberDrawerPage() {
   const { memberId } = useParams<{ orgId: string; memberId: string }>();
   const member = useMembersStore((state) => state.getMemberById(memberId));

   if (!member) {
      return null;
   }

   return (
      <DetailDrawerShell header={<Header member={member} />}>
         <MemberProfile member={member} />
      </DetailDrawerShell>
   );
}
