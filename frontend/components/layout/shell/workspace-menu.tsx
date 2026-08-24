'use client';

import Link from 'next/link';

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

/**
 * Contents of the workspace menu behind the brand.
 *
 * Extracted so the shell rail and the legacy sidebar's OrgSwitcher render one
 * definition. Two copies of a menu drift, and the drift is invisible until
 * someone notices an action missing from one of them.
 */
export function WorkspaceMenuItems({ orgId }: { orgId?: string }) {
   const workspace = orgId || WORKSPACE_SLUG;
   return (
      <>
         <DropdownMenuGroup>
            <DropdownMenuItem asChild>
               <Link href={`/${workspace}/settings`}>
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
                  <DropdownMenuLabel>{WORKSPACE_NAME}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                     <BerryMark size="sm" />
                     {WORKSPACE_NAME}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>create or join workspace</DropdownMenuItem>
                  <DropdownMenuItem>add an account</DropdownMenuItem>
               </DropdownMenuSubContent>
            </DropdownMenuPortal>
         </DropdownMenuSub>
         <DropdownMenuItem>
            log out
            <DropdownMenuShortcut>⌥⇧Q</DropdownMenuShortcut>
         </DropdownMenuItem>
      </>
   );
}
