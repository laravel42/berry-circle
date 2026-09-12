'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One field that saves itself.
 *
 * The settings pages each grew their own answer to "when does this write?" —
 * profile committed on blur, the catalogues wrote on every click, and none of
 * them said whether the write landed. This is the one answer: a quiet period
 * after the last keystroke, an immediate write on blur, and a state a reader
 * can see.
 *
 * Three things it deliberately does *not* do:
 *
 *   - It never writes a value `accepts` refuses. A blank name is not a change
 *     someone meant, and saving it would empty a field they are still typing.
 *   - It never writes a value the server already has. Re-sending the same
 *     string on every blur would flash "Saving…" for nothing.
 *   - It never lets an older write report over a newer one. Two edits in
 *     flight can settle out of order, and the slower first one would otherwise
 *     leave the field claiming a value the server has since replaced.
 *
 * `accepts` and `equals` are read on every call, so a caller may pass an inline
 * function without making the hook re-arm its timer.
 */

/** What the indicator beside an autosaving field reports. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export interface Autosave<T> {
   /** The draft — what the field renders. Undefined until the first load. */
   value: T | undefined;
   /** Records an edit and schedules the write. */
   change: (next: T) => void;
   /** Writes now, when there is something to write. For `onBlur`. */
   flush: () => void;
   /** Drops the draft back to the value the server last confirmed. */
   revert: () => void;
   /** Repeats the write that failed. */
   retry: () => void;
   state: SaveState;
   /** Why the last write failed, for the indicator. */
   error: string | null;
}

export interface AutosaveOptions<T> {
   /** The value the server has. Re-seeds the draft while it is untouched. */
   saved: T | undefined;
   /** Writes the value. A rejection puts the field in the failed state. */
   save: (value: T) => Promise<unknown>;
   /** False for a draft that must not be written, such as a blank name. */
   accepts?: (value: T) => boolean;
   /** Defaults to `Object.is`; give one for a value that is not a primitive. */
   equals?: (a: T, b: T) => boolean;
   /** Quiet period after the last edit, in milliseconds. */
   delay?: number;
}

export function useAutosave<T>(options: AutosaveOptions<T>): Autosave<T> {
   const { saved, delay = 600 } = options;

   const [value, setValue] = useState<T | undefined>(saved);
   const [state, setState] = useState<SaveState>('idle');
   const [error, setError] = useState<string | null>(null);

   // Read through a ref so the callbacks below stay stable across renders; a
   // caller passing an inline `accepts` would otherwise re-arm the timer on
   // every keystroke.
   const latest = useRef(options);
   latest.current = options;

   /** The value the server last confirmed, so a no-op edit writes nothing. */
   const committed = useRef<T | undefined>(saved);
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
   /** The draft differs from `committed` and has not been written yet. */
   const pending = useRef(false);
   /** A write is in flight; the re-seed must not overwrite it. */
   const writing = useRef(false);
   /** Only the newest write may report its result. */
   const generation = useRef(0);
   const draft = useRef<T | undefined>(saved);

   const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
   };

   const write = useCallback((next: T) => {
      clear();
      const { accepts, equals, save } = latest.current;
      if (accepts && !accepts(next)) return;
      const same = equals ?? Object.is;
      if (committed.current !== undefined && same(next, committed.current)) {
         pending.current = false;
         return;
      }

      const mine = ++generation.current;
      pending.current = false;
      writing.current = true;
      setState('saving');
      setError(null);

      void save(next).then(
         () => {
            if (generation.current !== mine) return;
            writing.current = false;
            committed.current = next;
            setState('saved');
         },
         (cause: unknown) => {
            if (generation.current !== mine) return;
            writing.current = false;
            setState('failed');
            setError(cause instanceof Error ? cause.message : 'This could not be saved.');
         }
      );
   }, []);

   const change = useCallback(
      (next: T) => {
         draft.current = next;
         setValue(next);
         pending.current = true;
         clear();
         timer.current = setTimeout(() => write(next), delay);
      },
      [delay, write]
   );

   const flush = useCallback(() => {
      if (!pending.current || draft.current === undefined) return;
      write(draft.current);
   }, [write]);

   const revert = useCallback(() => {
      clear();
      pending.current = false;
      draft.current = committed.current;
      setValue(committed.current);
      setState('idle');
      setError(null);
   }, []);

   const retry = useCallback(() => {
      if (draft.current === undefined) return;
      write(draft.current);
   }, [write]);

   // Adopt what the server says while the field is untouched, so a value
   // changed on another device appears here. A draft mid-edit or mid-write is
   // left alone: adopting then would delete what someone is typing.
   useEffect(() => {
      if (saved === undefined || pending.current || writing.current || timer.current) return;
      committed.current = saved;
      draft.current = saved;
      setValue(saved);
   }, [saved]);

   // A scheduled write does not survive the page it was typed on. Blur flushes
   // first in every real interaction, so this only drops an edit whose field
   // was unmounted while still focused.
   useEffect(() => clear, []);

   return { value, change, flush, revert, retry, state, error };
}
