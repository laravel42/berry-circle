'use client';

import { useShortcut } from '@/components/layout/shortcut-provider';
import type { InboxItem } from '@/data/inbox';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect } from 'react';

/** The two lists the page can be showing. */
export const INBOX_VIEWS = ['active', 'archived'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

/**
 * Which list is on screen, in the URL.
 *
 * A reader who archives half an inbox and sends someone the link should be
 * showing them the archive, so this is query state rather than component
 * state — as is the selection below.
 */
export function useInboxView() {
   return useQueryState('view', parseAsStringLiteral(INBOX_VIEWS).withDefault('active'));
}

/** The selected notification, in the URL as `?issue=`. */
export function useInboxSelection() {
   return useQueryState('issue');
}

export interface InboxFilters {
   /** UI status ids of the task a notification is about. */
   statuses: string[];
   /** UI priority ids of that task. */
   priorities: string[];
   /** Sender keys: a member id, `agent`, or `system`. */
   senders: string[];
   unreadOnly: boolean;
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
   statuses: [],
   priorities: [],
   senders: [],
   unreadOnly: false,
};

/** The sender bucket a notification with no named actor falls into. */
export const SENDER_AGENT = 'agent';
export const SENDER_SYSTEM = 'system';

/** What a notification is filtered on, once the live task is folded in. */
export interface InboxFacets {
   status: string | null;
   priority: string | null;
   sender: string;
}

export type FacetResolver = (item: InboxItem) => InboxFacets;

export function senderKey(item: InboxItem): string {
   if (!item.actor) return SENDER_SYSTEM;
   return item.actor.type === 'agent' ? SENDER_AGENT : item.actor.id;
}

/** How many filter groups are narrowing the list. */
export function activeFilterCount(filters: InboxFilters): number {
   return (
      (filters.statuses.length > 0 ? 1 : 0) +
      (filters.priorities.length > 0 ? 1 : 0) +
      (filters.senders.length > 0 ? 1 : 0) +
      (filters.unreadOnly ? 1 : 0)
   );
}

export function hasActiveFilters(filters: InboxFilters): boolean {
   return activeFilterCount(filters) > 0;
}

export function applyInboxFilters(
   items: InboxItem[],
   filters: InboxFilters,
   facetsOf: FacetResolver
): InboxItem[] {
   return items.filter((item) => {
      if (filters.unreadOnly && item.read) return false;
      const facets = facetsOf(item);
      if (filters.statuses.length > 0) {
         if (!facets.status || !filters.statuses.includes(facets.status)) return false;
      }
      if (filters.priorities.length > 0) {
         if (!facets.priority || !filters.priorities.includes(facets.priority)) return false;
      }
      if (filters.senders.length > 0 && !filters.senders.includes(facets.sender)) return false;
      return true;
   });
}

/**
 * How many notifications each facet value would match.
 *
 * Counted over the list before filtering, so a count never drops to zero
 * merely because the value it counts is not currently selected.
 */
export function countFacet(
   items: InboxItem[],
   facetsOf: FacetResolver,
   pick: (facets: InboxFacets) => string | null
): Record<string, number> {
   const counts: Record<string, number> = {};
   for (const item of items) {
      const value = pick(facetsOf(item));
      if (!value) continue;
      counts[value] = (counts[value] ?? 0) + 1;
   }
   return counts;
}

/**
 * What to select once `removedId` leaves the list: the one after it, else the
 * one before it, else nothing. Archiving from the keyboard has to leave the
 * cursor somewhere sensible, and the end of a list is not it.
 */
export function selectionAfterRemoval(items: InboxItem[], removedId: string): string | null {
   const index = items.findIndex((item) => item.id === removedId);
   if (index === -1) return null;
   const next = items[index + 1] ?? items[index - 1];
   return next ? next.id : null;
}

/** A keystroke that should reach the page rather than whatever is focused. */
function keystrokeIsOurs(event: KeyboardEvent): boolean {
   if (event.metaKey || event.ctrlKey || event.altKey) return false;
   const target = event.target;
   if (target instanceof HTMLElement) {
      if (target.isContentEditable) return false;
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
   }
   // A dialog, sheet or command palette on screen owns the keyboard until it
   // closes. Radix marks every one of them open on the element itself.
   if (typeof document !== 'undefined') {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return false;
      if (document.querySelector('[role="alertdialog"][data-state="open"]')) return false;
   }
   return true;
}

export interface InboxKeyboardOptions {
   items: InboxItem[];
   selectedId: string | null;
   onSelect: (id: string) => void;
   /** `E`: archive in the inbox, put back in the archive. */
   onArchiveKey: () => void;
   enabled?: boolean;
}

/**
 * Up, down and `E`.
 *
 * `E` goes through the shell's registry, so archiving is one rebindable row in
 * settings shared with the notifications drawer; the arrows stay a local
 * listener, because moving a selection is not an action anyone rebinds and
 * there is no registry entry for it.
 */
export function useInboxKeyboard({
   items,
   selectedId,
   onSelect,
   onArchiveKey,
   enabled = true,
}: InboxKeyboardOptions): void {
   useEffect(() => {
      if (!enabled) return;
      const onKeyDown = (event: KeyboardEvent) => {
         if (!keystrokeIsOurs(event)) return;
         const key = event.key;
         if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (items.length === 0) return;
            event.preventDefault();
            const index = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
            if (index === -1) {
               // Entering the list: from the top going down, the bottom
               // going up.
               const entry = key === 'ArrowDown' ? items[0] : items[items.length - 1];
               if (entry) onSelect(entry.id);
               return;
            }
            const nextIndex = key === 'ArrowDown' ? index + 1 : index - 1;
            const next = items[nextIndex];
            if (next) onSelect(next.id);
            return;
         }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
   }, [enabled, items, selectedId, onSelect]);

   useShortcut(
      'inbox.archive',
      () => {
         if (selectedId) onArchiveKey();
      },
      { enabled }
   );
}
