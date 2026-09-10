'use client';

import { notFound, useParams } from 'next/navigation';

import MemberProfile from '@/components/common/members/member-profile';
import Header from '@/components/layout/headers/profile/header';
import MainLayout from '@/components/layout/main-layout';
import { useMembersStore } from '@/store/members-store';

export default function MemberProfilePage() {
   const { memberId } = useParams<{ orgId: string; memberId: string }>();
   const members = useMembersStore((state) => state.members);
   const member = members.find((candidate) => candidate.id === memberId);

   if (!member) {
      // Members hydrate after the session loads; only an answered list that
      // lacks the id is a real miss.
      if (members.length > 0) notFound();
      return null;
   }

   return (
      <MainLayout header={<Header member={member} />}>
         <MemberProfile member={member} />
      </MainLayout>
   );
}
