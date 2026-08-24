'use client';

import * as React from 'react';
import { Check, Laptop, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEMES = [
   { id: 'dark', label: 'Berry dark', icon: Moon },
   { id: 'light', label: 'Berry light', icon: Sun },
   { id: 'system', label: 'System', icon: Laptop },
] as const;

export function ThemeToggle() {
   const { theme, setTheme } = useTheme();
   const [mounted, setMounted] = React.useState(false);

   React.useEffect(() => {
      setMounted(true);
   }, []);

   const selected = THEMES.find((candidate) => candidate.id === theme) ?? THEMES[0];
   const SelectedIcon = mounted ? selected.icon : Moon;

   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button
               variant="ghost"
               size="icon"
               className="size-8 shrink-0"
               aria-label="Choose color theme"
            >
               <SelectedIcon className="size-4" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-44">
            {THEMES.map((candidate) => {
               const Icon = candidate.icon;
               return (
                  <DropdownMenuItem
                     key={candidate.id}
                     onClick={() => setTheme(candidate.id)}
                     className="gap-2"
                  >
                     <Icon className="size-4" />
                     <span className="flex-1">{candidate.label}</span>
                     {candidate.id === selected.id && <Check className="size-3.5" />}
                  </DropdownMenuItem>
               );
            })}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
