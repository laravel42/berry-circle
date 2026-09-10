import { redirect } from 'next/navigation';

/**
 * App root. Sign-in returns to `/`, so this
 * is the single hand-off into onboarding — the one place that decides where a
 * signed-in user lands. Onboarding reads `/me/bootstrap` and either routes into
 * the resolved workspace (previously selected if valid, else earliest-joined)
 * within budget or shows the create-or-join step when there is no membership.
 * The SessionGate still bounces an anonymous visitor to `/sign-in` first.
 */
export default function Home() {
   redirect('/onboarding');
}
