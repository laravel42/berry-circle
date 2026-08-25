'use client';

import { Check, Laptop, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { SettingsCard } from './shared';

const THEMES = [
   {
      id: 'dark',
      label: 'Berry dark',
      description: 'Void canvas, Chalk type, and state-tinted work surfaces.',
      icon: Moon,
      preview: 'bg-void',
   },
   {
      id: 'light',
      label: 'Berry light',
      description: 'A print-like inversion for bright working environments.',
      icon: Sun,
      preview: 'bg-chalk',
   },
   {
      id: 'system',
      label: 'System',
      description: 'Follow the appearance selected on this device.',
      icon: Laptop,
      preview: 'bg-[linear-gradient(90deg,var(--brand-void)_50%,var(--brand-chalk)_50%)]',
   },
] as const;

export function ThemePreferences() {
   const { theme, setTheme } = useTheme();
   const [mounted, setMounted] = useState(false);

   useEffect(() => setMounted(true), []);

   const selected = mounted && THEMES.some((candidate) => candidate.id === theme) ? theme : 'dark';

   return (
      <SettingsCard className="overflow-hidden">
         <div role="radiogroup" aria-label="Interface theme">
            {THEMES.map((candidate) => {
               const Icon = candidate.icon;
               const checked = candidate.id === selected;

               return (
                  <button
                     key={candidate.id}
                     type="button"
                     role="radio"
                     aria-checked={checked}
                     onClick={() => setTheme(candidate.id)}
                     className={cn(
                        'flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors',
                        'border-b border-border/60 last:border-b-0 hover:bg-accent/60',
                        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50',
                        checked && 'bg-accent/40'
                     )}
                  >
                     <span
                        className={cn(
                           'relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border',
                           candidate.preview
                        )}
                     >
                        <Icon
                           className={cn(
                              'size-4',
                              candidate.id === 'light' ? 'text-void' : 'text-chalk'
                           )}
                        />
                        <span className="absolute right-1.5 bottom-1.5 size-1.5 bg-berry" />
                     </span>
                     <span className="min-w-0 flex-1">
                        <span className="block font-medium">{candidate.label}</span>
                        <span className="mt-0.5 block leading-relaxed text-muted-foreground">
                           {candidate.description}
                        </span>
                     </span>
                     <span
                        className={cn(
                           'flex size-5 items-center justify-center border',
                           checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input text-transparent'
                        )}
                     >
                        <Check className="size-3.5" />
                     </span>
                  </button>
               );
            })}
         </div>
      </SettingsCard>
   );
}
