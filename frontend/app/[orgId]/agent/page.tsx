import { redirect } from 'next/navigation';

export default async function AgentPage({ params }: { params: Promise<{ orgId: string }> }) {
   const { orgId } = await params;
   redirect(`/${orgId}/agents`);
}
