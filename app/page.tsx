import { WORKSPACE_SLUG } from '@/lib/config';
import { redirect } from 'next/navigation';

export default function Home() {
   redirect(`${WORKSPACE_SLUG}/teams`);
}
