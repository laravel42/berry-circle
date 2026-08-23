interface ShellIconProps {
   /** Inner SVG markup on a 24x24 viewBox. */
   path: string;
   size?: number;
   className?: string;
}

/**
 * Renders a route glyph from the prototype's inline path data.
 *
 * The markup is a compile-time constant from `shell-routes.ts` — never user or
 * API content — so `dangerouslySetInnerHTML` carries no injection risk here.
 * Keeping the icons as path strings is what lets the route table stay a plain
 * data file rather than a module of components.
 */
export function ShellIcon({ path, size = 15, className }: ShellIconProps) {
   return (
      <svg
         width={size}
         height={size}
         viewBox="0 0 24 24"
         fill="none"
         stroke="currentColor"
         strokeWidth={1.6}
         className={className}
         aria-hidden="true"
         dangerouslySetInnerHTML={{ __html: path }}
      />
   );
}

/** The Berry mark: brackets around a berry. */
export function BerryMark({ size = 17, muted = false }: { size?: number; muted?: boolean }) {
   const bracket = muted ? '#8a8a90' : 'var(--shell-text)';
   const weight = muted ? 7 : 6;
   return (
      <svg width={size} height={size} viewBox="0 0 64 64" className="flex-none" aria-hidden="true">
         <path d="M14 8H8v48h6" stroke={bracket} strokeWidth={weight} fill="none" />
         <path d="M50 8h6v48h-6" stroke={bracket} strokeWidth={weight} fill="none" />
         <circle cx="32" cy="32" r={muted ? 14 : 13} fill="var(--shell-accent)" />
      </svg>
   );
}
