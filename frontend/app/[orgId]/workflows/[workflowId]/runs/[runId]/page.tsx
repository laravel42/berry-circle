import { redirect } from 'next/navigation';

interface Props {
   params: Promise<{ orgId: string; workflowId: string; runId: string }>;
}

export default async function WorkflowRunRedirect({ params }: Props) {
   const { orgId, workflowId, runId } = await params;
   redirect(`/${orgId}/workflow/${workflowId}/run/${runId}`);
}
