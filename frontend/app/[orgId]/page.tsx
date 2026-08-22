import { WORKSPACE_SLUG } from '@/lib/config';
import { redirect } from 'next/navigation';

export default function OrgIdPage() {
   redirect(`${WORKSPACE_SLUG}/teams`);
}
