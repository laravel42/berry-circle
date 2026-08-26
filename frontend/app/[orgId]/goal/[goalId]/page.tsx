import { redirect } from 'next/navigation';

interface Props {
   params: Promise<{ orgId: string; goalId: string }>;
}

export default async function GoalIndexRedirect({ params }: Props) {
   const { orgId, goalId } = await params;
   redirect(`/${orgId}/goal/${goalId}/overview`);
}
