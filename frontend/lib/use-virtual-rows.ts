'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fixed-height row windowing for long tables: only the rows in view (plus an
 * overscan) are rendered, inside a spacer as tall as all of them.
 */
export function useVirtualRows(count: number, rowHeight: number, overscan = 8) {
   const ref = useRef<HTMLDivElement>(null);
   const [range, setRange] = useState({ start: 0, end: 60 });

   useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const update = () => {
         const start = Math.max(0, Math.floor(element.scrollTop / rowHeight) - overscan);
         const end = Math.min(count, Math.ceil((element.scrollTop + element.clientHeight) / rowHeight) + overscan);
         setRange({ start, end });
      };
      update();
      element.addEventListener('scroll', update, { passive: true });
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => {
         element.removeEventListener('scroll', update);
         observer.disconnect();
      };
   }, [count, rowHeight, overscan]);

   return {
      ref,
      start: range.start,
      end: Math.min(range.end, count),
      totalHeight: count * rowHeight,
      offset: range.start * rowHeight,
   };
}
