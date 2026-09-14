import { redirect } from 'next/navigation';

/**
 * The tasks page used to live here. Bookmarks, persisted tabs and links in
 * old comments still say `/my-issues`, so the old address forwards to the
 * new one, query string and all.
 */
export default async function MyIssuesRedirect({
   params,
   searchParams,
}: {
   params: Promise<{ orgId: string }>;
   searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
   const { orgId } = await params;
   const query = new URLSearchParams();
   for (const [key, value] of Object.entries(await searchParams)) {
      for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
         query.append(key, each);
      }
   }
   const suffix = query.toString();
   redirect(`/${orgId}/tasks${suffix ? `?${suffix}` : ''}`);
}
