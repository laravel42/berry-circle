'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Box, GripVertical, Layers, X } from 'lucide-react';

import { subscribeWorkspaceEvents } from '@/lib/events';
import { loadPins, reorderPins, unpinTarget, type Pin } from '@/lib/pins';
import { renderStatusIcon } from '@/lib/status-utils';
import { usePinsStore } from '@/store/pins-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';

/** How many pins show before "show more". */
const COLLAPSED = 5;

/** A burst of events settles before the list is asked for again. */
const REFRESH_DEBOUNCE_MS = 400;

function hrefFor(orgId: string, pin: Pin): string {
   if (pin.targetType === 'issue') return `/${orgId}/issue/${pin.identifier ?? pin.targetId}`;
   if (pin.targetType === 'view') return `/${orgId}/view/${pin.targetId}`;
   return `/${orgId}/project/${pin.targetId}/overview`;
}

/**
 * The rail's "pinned" section: tasks, projects and saved views a person keeps
 * at hand. Hidden when nothing is pinned.
 *
 * A pin whose target is deleted, or which stops being visible to this person,
 * simply stops being listed: `GET /api/v1/pins` leaves it out rather than
 * answering with a blank row, so the list is re-read whenever the workspace
 * stream says something that could have removed one. That is the whole of
 * "drop pins that 404" — the client never has to ask about a target it cannot
 * see, and no dead row is ever rendered.
 */
export function ShellPins({ orgId }: { orgId: string }) {
   const t = useTranslations('navigation.sidebar');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, hydrate, remove, move } = usePinsStore();
   const issues = useIssuesStore((state) => state.issues);
   const [expanded, setExpanded] = useState(false);
   const [dragIndex, setDragIndex] = useState<number | null>(null);
   const fromRef = useRef<number | null>(null);
   const overRef = useRef<number | null>(null);
   const listRef = useRef<HTMLUListElement>(null);

   const refresh = useCallback(() => {
      if (!workspaceId) return;
      void loadPins(workspaceId)
         .then(hydrate)
         .catch(() => undefined);
   }, [workspaceId, hydrate]);

   useEffect(refresh, [refresh]);

   // A task or project that disappears takes its pin with it. The stream says
   // when that might have happened; the list says what is left.
   useEffect(() => {
      if (!workspaceId) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!/^(issue|project|view)\./.test(event.type)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
      });
      return () => {
         if (timer) clearTimeout(timer);
         unsubscribe();
      };
   }, [workspaceId, refresh]);

   const unpin = async (pin: Pin) => {
      remove(pin.id);
      try {
         await unpinTarget(workspaceId, pin.id);
      } catch {
         // The server still has it; the next read puts it back rather than
         // leaving the rail claiming something that is not true.
         refresh();
      }
   };

   // Pointer-driven rather than HTML5 drag-and-drop: the rail is a flex column
   // inside a transformed shell, where `drop` does not reliably fire.
   const rowAt = (clientY: number): number | null => {
      const root = listRef.current;
      if (!root) return null;
      const rows = root.querySelectorAll<HTMLElement>('[data-pin-row]');
      for (let index = 0; index < rows.length; index++) {
         const rect = rows[index].getBoundingClientRect();
         if (clientY < rect.top + rect.height / 2) return index;
      }
      return rows.length - 1;
   };

   const onGripDown = (index: number) => (event: PointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      fromRef.current = index;
      overRef.current = index;
      setDragIndex(index);
   };

   const onGripMove = (event: PointerEvent<HTMLSpanElement>) => {
      if (fromRef.current === null) return;
      const next = rowAt(event.clientY);
      if (next === null || next === overRef.current) return;
      move(overRef.current ?? fromRef.current, next);
      overRef.current = next;
      setDragIndex(next);
   };

   const onGripUp = () => {
      const from = fromRef.current;
      const to = overRef.current;
      fromRef.current = null;
      overRef.current = null;
      setDragIndex(null);
      if (from === null || to === null || from === to) return;
      void reorderPins(
         workspaceId,
         usePinsStore.getState().pins.map((pin) => pin.id)
      )
         .then(hydrate)
         .catch(refresh);
   };

   const cancelDrag = () => {
      fromRef.current = null;
      overRef.current = null;
      setDragIndex(null);
      refresh();
   };

   if (pins.length === 0) return null;
   const shown = expanded ? pins : pins.slice(0, COLLAPSED);

   return (
      <div>
         <div className="px-6 pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {t('pinned')}
         </div>
         <ul ref={listRef} className="flex flex-col gap-1 px-3">
            {shown.map((pin, index) => {
               // The status mark comes from the task the board already loaded.
               // A pin carries a title, not a status, and asking the server for
               // one status per pin would be five requests to draw five dots.
               const issue =
                  pin.targetType === 'issue'
                     ? issues.find(
                          (candidate) =>
                             candidate.id === pin.targetId ||
                             candidate.identifier === pin.identifier
                       )
                     : undefined;
               return (
                  <li
                     key={pin.id}
                     data-pin-row
                     className={[
                        'group/pin flex items-center gap-1 rounded pr-1',
                        dragIndex === index
                           ? 'bg-[var(--shell-hover)]'
                           : 'hover:bg-[var(--shell-hover)]',
                     ].join(' ')}
                  >
                     <span
                        onPointerDown={onGripDown(index)}
                        onPointerMove={onGripMove}
                        onPointerUp={onGripUp}
                        onPointerCancel={cancelDrag}
                        aria-label={t('reorder', { title: pin.title })}
                        className="flex size-4 flex-none cursor-grab touch-none items-center justify-center text-[var(--shell-text-faint)] opacity-0 transition-opacity group-hover/pin:opacity-100 active:cursor-grabbing [&_svg]:pointer-events-none"
                     >
                        <GripVertical className="size-3" />
                     </span>
                     <Link
                        data-shell-nav
                        href={hrefFor(orgId, pin)}
                        className="flex min-w-0 flex-1 items-center gap-2 truncate rounded py-1.5 text-[var(--shell-text-muted)] hover:text-[var(--shell-text)]"
                     >
                        <span className="flex size-4 flex-none items-center justify-center">
                           {pin.targetType === 'issue' ? (
                              ((issue && renderStatusIcon(issue.status.id)) ?? (
                                 <span className="size-1.5 rounded-full bg-[var(--shell-text-faint)]" />
                              ))
                           ) : pin.targetType === 'project' ? (
                              <Box className="size-3.5" />
                           ) : (
                              <Layers className="size-3.5" />
                           )}
                        </span>
                        {pin.identifier ? (
                           <span className="flex-none text-[var(--shell-text-dim)]">
                              {pin.identifier}
                           </span>
                        ) : null}
                        <span className="truncate">{pin.title}</span>
                     </Link>
                     <button
                        type="button"
                        onClick={() => void unpin(pin)}
                        aria-label={t('unpin', { title: pin.title })}
                        className="flex size-5 flex-none items-center justify-center rounded text-[var(--shell-text-faint)] opacity-0 transition-opacity group-hover/pin:opacity-100 hover:text-[var(--shell-text)] focus-visible:opacity-100"
                     >
                        <X className="size-3" />
                     </button>
                  </li>
               );
            })}
         </ul>
         {pins.length > COLLAPSED ? (
            <button
               type="button"
               onClick={() => setExpanded((value) => !value)}
               className="mx-3 mt-px flex w-[calc(100%-1.5rem)] items-center rounded px-3 py-1 text-[var(--shell-text-dim)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
            >
               {expanded ? t('showLess') : t('showMore')}
            </button>
         ) : null}
      </div>
   );
}
