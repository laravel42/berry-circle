import { redirect } from 'next/navigation';

interface Props {
   params: Promise<{ orgId: string; workflowId: string }>;
}

/** `/workflows/:id/runs` → the history tab; the segment is `history` so `/runs` never lights up runtimes. */
export default async function WorkflowRunsRedirect({ params }: Props) {
   const { orgId, workflowId } = await params;
   redirect(`/${orgId}/workflow/${workflowId}/history`);
}
