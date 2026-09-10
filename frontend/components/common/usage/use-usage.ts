'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeWorkspaceEvents } from '@/lib/events';

export interface UsageState<T> {
   data: T | null;
   error: string | null;
   loading: boolean;
   reload: () => void;
}

/** A busy workspace reports usage on every model call; refresh at most this often. */
const REFRESH_DEBOUNCE_MS = 2000;

/**
 * Loads one usage read and reloads it when the workspace stream says usage
 * was recorded. `key` names the read, so changing the window or the subject
 * refetches; `load` may be null until the workspace is known.
 */
export function useUsage<T>(load: (() => Promise<T>) | null, key: string): UsageState<T> {
   const [data, setData] = useState<T | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);
   const [tick, setTick] = useState(0);
   const loadRef = useRef(load);
   loadRef.current = load;
   const reload = useCallback(() => setTick((value) => value + 1), []);

   useEffect(() => {
      const current = loadRef.current;
      if (!current) return;
      let cancelled = false;
      setLoading(true);
      current()
         .then((value) => {
            if (cancelled) return;
            setData(value);
            setError(null);
         })
         .catch((cause: unknown) => {
            if (!cancelled) {
               setError(cause instanceof Error ? cause.message : 'Usage could not be loaded.');
            }
         })
         .finally(() => {
            if (!cancelled) setLoading(false);
         });
      return () => {
         cancelled = true;
      };
   }, [key, tick]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (event.type !== 'usage.recorded' || timer) return;
         timer = setTimeout(() => {
            timer = null;
            reload();
         }, REFRESH_DEBOUNCE_MS);
      });
      return () => {
         if (timer) clearTimeout(timer);
         unsubscribe();
      };
   }, [reload]);

   return { data, error, loading, reload };
}
