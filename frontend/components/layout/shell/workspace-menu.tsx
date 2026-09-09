'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';

import { useSignOut } from '@/components/auth/use-sign-out';
import { BerryMark } from '@/components/brand/berry-mark';
import {
   DropdownMenuGroup,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuPortal,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { useSessionStore } from '@/store/session-store';

/**
 * Contents of the workspace menu behind the brand.
 *
 * Extracted so the shell rail and the legacy sidebar's OrgSwitcher render one
 * definition. Two copies of a menu drift, and the drift is invisible until
 * someone notices an action missing from one of them.
 *
 * Everything here reads the live session (the persisted active workspace and
 * the user's full membership list), so the menu reflects what the account can
 * actually see rather than the build-time `WORKSPACE_NAME`. `WORKSPACE_NAME`
 * remains only as the label before the session is ready.
 */
export function WorkspaceMenuItems({ orgId }: { orgId?: string }) {
   const router = useRouter();
   const active = useSessionStore((state) => state.workspace);
   const workspaces = useSessionStore((state) => state.workspaces);
   const switchWorkspace = useSessionStore((state) => state.switchWorkspace);
   const { signOut, pending } = useSignOut();

   // The slug that scopes settings/route links: the active workspace, the route
   // param, then the build-time default, in that order of trust.
   const slug = active?.slug || orgId || WORKSPACE_SLUG;
   const activeName = active?.name ?? WORKSPACE_NAME;

   const onSwitch = async (workspaceId: string) => {
      const next = await switchWorkspace(workspaceId);
      if (next) router.push(`/${next.slug}/my-issues`);
   };

   return (
      <>
         <DropdownMenuGroup>
            <DropdownMenuItem asChild>
               <Link href={`/${slug}/settings`}>
                  settings
                  <DropdownMenuShortcut>G then S</DropdownMenuShortcut>
               </Link>
            </DropdownMenuItem>
         </DropdownMenuGroup>
         <DropdownMenuSeparator />
         <DropdownMenuSub>
            <DropdownMenuSubTrigger>switch workspace</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
               <DropdownMenuSubContent>
                  <DropdownMenuLabel>{activeName}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {workspaces.length > 0 ? (
                     workspaces.map((workspace) => (
                        <DropdownMenuItem
                           key={workspace.id}
                           disabled={workspace.id === active?.id}
                           onSelect={(event) => {
                              event.preventDefault();
                              void onSwitch(workspace.id);
                           }}
                        >
                           <BerryMark size="sm" />
                           <span className="truncate">{workspace.name}</span>
                           {workspace.id === active?.id ? (
                              <Check className="ml-auto size-4" aria-hidden="true" />
                           ) : null}
                        </DropdownMenuItem>
                     ))
                  ) : (
                     <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                     onSelect={(event) => {
                        event.preventDefault();
                        router.push('/onboarding?add=1');
                     }}
                  >
                     create or join workspace
                  </DropdownMenuItem>
               </DropdownMenuSubContent>
            </DropdownMenuPortal>
         </DropdownMenuSub>
         <DropdownMenuItem
            disabled={pending}
            onSelect={(event) => {
               event.preventDefault();
               void signOut();
            }}
         >
            log out
            <DropdownMenuShortcut>⌥⇧Q</DropdownMenuShortcut>
         </DropdownMenuItem>
      </>
   );
}
