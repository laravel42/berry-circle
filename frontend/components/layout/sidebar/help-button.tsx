'use client';

import * as React from 'react';
import { HelpCircle, Keyboard } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

export function HelpButton() {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button size="icon" variant="outline">
               <HelpCircle className="size-4" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Shortcuts</DropdownMenuLabel>
            <DropdownMenuItem>
               <Keyboard className="mr-2 h-4 w-4" />
               <span>Keyboard shortcuts</span>
               <span className="ml-auto text-xs text-muted-foreground">⌘/</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>About</DropdownMenuLabel>
            <DropdownMenuItem>
               <span>Berry — frontend based on the Circle template (MIT)</span>
            </DropdownMenuItem>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
