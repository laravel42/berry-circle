'use client';

import { notFound, useParams } from 'next/navigation';

import MemberProfile from '@/components/common/members/member-profile';
import Header from '@/components/layout/headers/profile/header';
import MainLayout from '@/components/layout/main-layout';
import { useMembersStore } from '@/store/members-store';

/**
 * A member, under the members list they were found in.
 *
 * `/profiles/[memberId]` renders the same person and stays, because links to
 * it exist and the drawer intercepts it. This is the path the members list
 * links to, so walking from the list to a person and back does not change
 * which section of the app the URL says you are in.
 */
export default function WorkspaceMemberPage() {
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
