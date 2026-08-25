'use client';

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export type BerryMarkTone = 'brand' | 'neutral' | 'working' | 'attention' | 'complete' | 'danger';

export type BerryMarkState = 'solid' | 'hollow' | 'crossed';

const toneClasses: Record<BerryMarkTone, string> = {
   brand: 'text-berry',
   neutral: 'text-status-neutral',
   working: 'text-status-info',
   attention: 'text-status-warning',
   complete: 'text-status-success',
   danger: 'text-status-danger',
};

const sizeClasses = {
   sm: 'size-4',
   md: 'size-6',
   lg: 'size-9',
} as const;

interface BerryMarkProps extends Omit<ComponentProps<'svg'>, 'children'> {
   bracketClassName?: string;
   label?: string;
   pulse?: boolean;
   size?: keyof typeof sizeClasses;
   state?: BerryMarkState;
   tone?: BerryMarkTone;
}

export function BerryMark({
   bracketClassName,
   className,
   label,
   pulse = false,
   size = 'md',
   state = 'solid',
   tone = 'brand',
   ...props
}: BerryMarkProps) {
   const accessibility = label
      ? { 'role': 'img', 'aria-label': label }
      : { 'aria-hidden': true as const };

   return (
      <svg
         viewBox="0 0 64 64"
         fill="none"
         focusable="false"
         className={cn('shrink-0 overflow-visible', sizeClasses[size], className)}
         {...accessibility}
         {...props}
      >
         <path
            d="M20 10H10V54H20M44 10H54V54H44"
            className={cn('text-foreground', bracketClassName)}
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="butt"
            strokeLinejoin="miter"
         />
         {state === 'crossed' ? (
            <path
               d="M24 24L40 40M40 24L24 40"
               className={toneClasses[tone]}
               stroke="currentColor"
               strokeWidth="6"
               strokeLinecap="butt"
            />
         ) : (
            <>
               {pulse && (
                  <circle
                     cx="32"
                     cy="32"
                     r="14"
                     className={cn(
                        'origin-center fill-none stroke-current',
                        toneClasses[tone],
                        'animate-[berry-working_2s_ease-in-out_infinite]'
                     )}
                     strokeWidth="3"
                  />
               )}
               <circle
                  cx="32"
                  cy="32"
                  r="10"
                  className={cn(
                     'origin-center stroke-current',
                     state === 'hollow' ? 'fill-none' : 'fill-current',
                     toneClasses[tone],
                     pulse && 'animate-[berry-working_2s_ease-in-out_infinite]'
                  )}
                  strokeWidth={state === 'hollow' ? 4 : 0}
               />
            </>
         )}
      </svg>
   );
}

const wordmarkSizes = {
   sm: { mark: 'sm' as const },
   md: { mark: 'md' as const },
   lg: { mark: 'lg' as const },
};

interface BerryWordmarkProps {
   className?: string;
   size?: keyof typeof wordmarkSizes;
}

export function BerryWordmark({ className, size = 'md' }: BerryWordmarkProps) {
   const sizing = wordmarkSizes[size];

   return (
      <span className={cn('inline-flex items-center gap-2', className)} aria-label="Berry">
         <BerryMark size={sizing.mark} />
         {/* The word is drawn to the mark beside it, so its size comes from
             `size` rather than from the type scale. Sized by attribute in
             app/globals.css: the lockup is the one sanctioned exception, and it
             is easier to keep honest sitting next to the rule it departs from
             than as a lone text-* utility out here. */}
         <span
            data-wordmark={size}
            className="font-display leading-none tracking-[-0.025em] text-foreground"
         >
            Berry<span className="text-berry">.</span>
         </span>
      </span>
   );
}
