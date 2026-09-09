import { redirect } from 'next/navigation';

/** Legacy entry point. The real screen is `/sign-in`; forward any stale link. */
export default function LoginPage() {
   redirect('/sign-in');
}
