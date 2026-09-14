'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * The thin bar across the top of the canvas while a page is being fetched.
 *
 * Next's app router gives no navigation-start event a layout can subscribe to,
 * so the start is observed the way a person perceives it: a click on something
 * that navigates. The end is real — a new pathname or query means the new page
 * has rendered — and there is a ceiling, so a navigation that never completes
 * (an error boundary, a cancelled prefetch) cannot leave the bar on screen
 * forever.
 *
 * It creeps rather than tracks, because there is nothing to track: the width
 * eases towards 90% and only ever reaches 100% when the page actually arrives.
 */
const CREEP_MS = 180;
const CEILING = 90;
const GIVE_UP_MS = 10_000;

export function NavigationProgress() {
   const t = useTranslations('navigation.progress');
   const pathname = usePathname();
   const search = useSearchParams();
   const [progress, setProgress] = useState<number | null>(null);

   // The route we were on when the bar started. The bar ends when the rendered
   // route differs from it, which is the only reliable "arrived" signal.
   const startedAt = useRef<string | null>(null);
   const route = `${pathname}?${search?.toString() ?? ''}`;

   useEffect(() => {
      const onClick = (event: MouseEvent) => {
         // Modified clicks open a new tab; nothing in this tab is loading.
         if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
         ) {
            return;
         }
         const anchor = (event.target as HTMLElement | null)?.closest?.('a');
         if (!(anchor instanceof HTMLAnchorElement)) return;
         if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
         const href = anchor.getAttribute('href');
         if (!href || href.startsWith('#') || href.startsWith('http')) return;
         if (href === route || href === pathname) return;

         startedAt.current = route;
         setProgress(8);
      };

      document.addEventListener('click', onClick, true);
      return () => document.removeEventListener('click', onClick, true);
   }, [route, pathname]);

   // Creep while it is showing, and give up rather than hang.
   useEffect(() => {
      if (progress === null) return;
      const creep = setInterval(() => {
         setProgress((value) =>
            value === null ? null : Math.min(CEILING, value + (CEILING - value) * 0.18)
         );
      }, CREEP_MS);
      const giveUp = setTimeout(() => setProgress(null), GIVE_UP_MS);
      return () => {
         clearInterval(creep);
         clearTimeout(giveUp);
      };
      // Only the transition from "hidden" to "showing" starts the timers; the
      // creeping value itself must not restart them.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [progress === null]);

   // Arrived: fill, then fade.
   useEffect(() => {
      if (startedAt.current === null || startedAt.current === route) return;
      startedAt.current = null;
      setProgress(100);
      const timer = setTimeout(() => setProgress(null), 240);
      return () => clearTimeout(timer);
   }, [route]);

   if (progress === null) return null;
   return (
      <div
         role="progressbar"
         aria-label={t('loading')}
         aria-valuemin={0}
         aria-valuemax={100}
         aria-valuenow={Math.round(progress)}
         className="pointer-events-none absolute inset-x-0 top-0 z-50 h-0.5"
      >
         <div
            className="h-full bg-[var(--shell-accent)] transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: `${progress}%`, opacity: progress === 100 ? 0 : 1 }}
         />
      </div>
   );
}
