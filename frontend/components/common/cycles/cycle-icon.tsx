import { cn } from '@/lib/utils';

/** Cycle glyph, shown wherever an issue or project references its cycle. */
export function CyclePlayIcon({ className }: { className?: string }) {
   return (
      <svg
         width="16"
         height="16"
         viewBox="0 0 16 16"
         fill="none"
         className={cn('text-muted-foreground shrink-0', className)}
         role="img"
         focusable="false"
      >
         <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
         <path d="M6.75 5.75L10.25 8L6.75 10.25V5.75Z" fill="currentColor" />
      </svg>
   );
}
