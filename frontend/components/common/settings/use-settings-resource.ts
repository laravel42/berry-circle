'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Load something, then change it, without every settings page writing the same
 * six pieces of state.
 *
 * Settings pages all have the same shape and the same two failure modes. A
 * page that reads nothing looks identical to a page whose read failed, and a
 * switch that flips optimistically and then fails leaves the screen claiming
 * something the server does not believe. Both are handled once, here:
 *
 *   - `error` is set when the read fails, so a page can say so rather than
 *     render an empty list that reads as "you have none".
 *   - `mutate` rolls the value back when the write fails, and says why. A
 *     control that stays where you put it after a failure is a lie, and the
 *     next reload contradicts it.
 */

export interface Resource<T> {
   value: T | null;
   loading: boolean;
   error: string | null;
   /** True while a write is in flight, so a control can disable itself. */
   saving: boolean;
   /** Applies `next` at once, calls the server, and rolls back if it refuses. */
   mutate: (next: T, write: () => Promise<T | void>) => Promise<boolean>;
   set: (next: T) => void;
   reload: () => void;
}

export function useSettingsResource<T>(
   load: () => Promise<T>,
   dependencies: unknown[] = []
): Resource<T> {
   const [value, setValue] = useState<T | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);
   const [nonce, setNonce] = useState(0);

   useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setError(null);
      void load()
         .then((loaded) => {
            if (!cancelled) setValue(loaded);
         })
         .catch((cause: unknown) => {
            if (cancelled) return;
            // Named rather than swallowed: an empty page and a failed read
            // look the same, and the fixes are opposite.
            setError(cause instanceof Error ? cause.message : 'This could not be loaded.');
         })
         .finally(() => {
            if (!cancelled) setLoading(false);
         });
      return () => {
         cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [nonce, ...dependencies]);

   const mutate = useCallback(
      async (next: T, write: () => Promise<T | void>): Promise<boolean> => {
         const previous = value;
         setValue(next);
         setSaving(true);
         try {
            const written = await write();
            // The server's answer wins where it gives one: it may have
            // normalised what was sent, and showing the request instead would
            // disagree with the next reload.
            if (written !== undefined) setValue(written as T);
            return true;
         } catch (cause) {
            setValue(previous);
            toast.error(cause instanceof Error ? cause.message : 'That could not be saved.');
            return false;
         } finally {
            setSaving(false);
         }
      },
      [value]
   );

   return {
      value,
      loading,
      error,
      saving,
      mutate,
      set: setValue,
      reload: () => setNonce((count) => count + 1),
   };
}
