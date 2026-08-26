import { redirect } from 'next/navigation';

interface Props {
   params: Promise<{ orgId: string; workflowId: string }>;
}

export default async function WorkflowIndexRedirect({ params }: Props) {
   const { orgId, workflowId } = await params;
   redirect(`/${orgId}/workflow/${workflowId}/overview`);
}
