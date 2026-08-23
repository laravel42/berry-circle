import { WORKSPACE_SLUG } from '@/lib/config';
import { redirect } from 'next/navigation';

/** Login is hidden for now; auto-login runs from the session store instead. */
export default function LoginPage() {
   redirect(`/${WORKSPACE_SLUG}/runs`);
}
