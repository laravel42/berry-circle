import { redirect } from 'next/navigation';

interface Props {
   params: Promise<{ orgId: string; workflowId: string }>;
}

/** The spec's `/workflows/:id` lands on the house-style detail route. */
export default async function WorkflowRedirect({ params }: Props) {
   const { orgId, workflowId } = await params;
   redirect(`/${orgId}/workflow/${workflowId}/overview`);
}
