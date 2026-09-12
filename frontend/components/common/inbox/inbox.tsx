'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { currentUser } from '@/data/users';
import type { InboxItem } from '@/data/inbox';
import { fetchInbox } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { useMembersStore } from '@/store/members-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useSessionStore } from '@/store/session-store';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { InboxDetail } from './inbox-detail';
import { InboxFilterBar } from './inbox-filters';
import { inboxHref } from './inbox-format';
import { InboxRow } from './inbox-row';
import { InboxPanel } from './inbox-states';
import {
   applyInboxFilters,
   EMPTY_INBOX_FILTERS,
   hasActiveFilters,
   SENDER_AGENT,
   SENDER_SYSTEM,
   selectionAfterRemoval,
   senderKey,
   useInboxKeyboard,
   useInboxSelection,
   useInboxView,
   type InboxFacets,
   type InboxFilters,
} from './use-inbox';

/** How much of the archive is read in one go. */
const ARCHIVE_PAGE = 100;

/**
 * The inbox: a list of notifications and the thing the selected one is about.
 *
 * Both the selection and which list is showing live in the URL, so a reader
 * can send someone what they are looking at. Everything else — the filters,
 * the keyboard, which rows are read — is state of this screen.
 */
export default function Inbox() {
   const params = useParams<{ orgId: string }>();
   const orgId = params?.orgId ?? '';
   const t = useTranslations('inbox');

   const [view, setView] = useInboxView();
   const [selectedId, setSelectedId] = useInboxSelection();
   const [filters, setFilters] = useState<InboxFilters>(EMPTY_INBOX_FILTERS);

   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const issues = useIssuesStore((state) => state.issues);
   const members = useMembersStore((state) => state.members);

   const notifications = useNotificationsStore((state) => state.notifications);
   const archivedItems = useNotificationsStore((state) => state.archived);
   const status = useNotificationsStore((state) => state.status);
   const archivedStatus = useNotificationsStore((state) => state.archivedStatus);
   const hydrateArchived = useNotificationsStore((state) => state.hydrateArchived);
   const setArchivedStatus = useNotificationsStore((state) => state.setArchivedStatus);
   const markReadOnOpen = useNotificationsStore((state) => state.markReadOnOpen);
   const markAsRead = useNotificationsStore((state) => state.markAsRead);
   const markAsUnread = useNotificationsStore((state) => state.markAsUnread);
   const markAllAsRead = useNotificationsStore((state) => state.markAllAsRead);
   const archiveNotification = useNotificationsStore((state) => state.archiveNotification);
   const unarchiveNotification = useNotificationsStore((state) => state.unarchiveNotification);
   const archiveMany = useNotificationsStore((state) => state.archiveMany);

   const archivedView = view === 'archived';

   // The archive is fetched the first time it is asked for, and again by hand
   // after a failure. The working inbox arrives with the rest of the
   // workspace, so nothing here loads it.
   const loadArchive = useCallback(async () => {
      if (!workspaceId) return;
      setArchivedStatus('loading');
      try {
         const items = await fetchInbox(workspaceId, user ?? currentUser, {
            state: 'archived',
            first: ARCHIVE_PAGE,
         });
         hydrateArchived(items);
      } catch {
         setArchivedStatus('error');
      }
   }, [workspaceId, user, hydrateArchived, setArchivedStatus]);

   useEffect(() => {
      if (archivedView && archivedStatus === 'idle') void loadArchive();
   }, [archivedView, archivedStatus, loadArchive]);

   const source = archivedView ? archivedItems : notifications;

   const facetsOf = useCallback(
      (item: InboxItem): InboxFacets => {
         const live = item.issueId ? issues.find((issue) => issue.id === item.issueId) : undefined;
         return {
            status: live?.status.id ?? item.issue?.status.id ?? null,
            priority: live?.priority.id ?? null,
            sender: senderKey(item),
         };
      },
      [issues]
   );

   const visible = useMemo(
      () => applyInboxFilters(source, filters, facetsOf),
      [source, filters, facetsOf]
   );

   const selected = useMemo(
      () => visible.find((item) => item.id === selectedId) ?? null,
      [visible, selectedId]
   );

   const listReady = archivedView ? archivedStatus === 'ready' : status === 'ready';

   // A filter that hides the selected notification clears the selection: the
   // detail pane must not go on showing something the list no longer offers.
   // Only once the list it would be in has actually loaded, or a deep link
   // would clear itself before its notification arrived.
   useEffect(() => {
      if (!selectedId || !listReady) return;
      if (!visible.some((item) => item.id === selectedId)) void setSelectedId(null);
   }, [selectedId, visible, listReady, setSelectedId]);

   // Opening a notification is reading it, unless the reader deliberately put
   // it back to unread.
   useEffect(() => {
      if (selected && !selected.read && !selected.archived) markReadOnOpen(selected.id);
   }, [selected, markReadOnOpen]);

   // Keep the selected row on screen when the keyboard moves it.
   useEffect(() => {
      if (!selectedId || typeof document === 'undefined') return;
      const row = document.querySelector(`[data-inbox-row="${selectedId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
   }, [selectedId, visible]);

   const senderName = useCallback(
      (key: string): string => {
         if (key === SENDER_AGENT) return t('filters.agents');
         if (key === SENDER_SYSTEM) return t('filters.system');
         return members.find((member) => member.id === key)?.name ?? t('filters.unknownSender');
      },
      [members, t]
   );

   const report = useCallback(
      (ok: boolean, message: string) => {
         if (ok) toast.success(message);
         else toast.error(t('toasts.failed'));
      },
      [t]
   );

   /** Archive or restore, moving the selection on before the row leaves. */
   const moveOut = useCallback(
      async (item: InboxItem) => {
         const next = selectionAfterRemoval(visible, item.id);
         if (selectedId === item.id) await setSelectedId(next);
         if (archivedView) {
            report(await unarchiveNotification(item.id), t('toasts.unarchived'));
         } else {
            report(await archiveNotification(item.id), t('toasts.archived'));
         }
      },
      [
         visible,
         selectedId,
         setSelectedId,
         archivedView,
         unarchiveNotification,
         archiveNotification,
         report,
         t,
      ]
   );

   const sweep = useCallback(
      async (items: InboxItem[]) => {
         if (items.length === 0) return;
         if (selectedId && items.some((item) => item.id === selectedId)) {
            await setSelectedId(null);
         }
         const ok = await archiveMany(items.map((item) => item.id));
         report(ok, t('toasts.archivedMany', { count: items.length }));
      },
      [archiveMany, report, selectedId, setSelectedId, t]
   );

   const onArchiveKey = useCallback(() => {
      const item = visible.find((candidate) => candidate.id === selectedId);
      if (item) void moveOut(item);
   }, [visible, selectedId, moveOut]);

   useInboxKeyboard({
      items: visible,
      selectedId,
      onSelect: (id) => void setSelectedId(id),
      onArchiveKey,
   });

   const completedItems = useMemo(
      () =>
         visible.filter((item) => {
            const live = item.issueId
               ? issues.find((issue) => issue.id === item.issueId)
               : undefined;
            const category = (live ?? item.issue)?.status.category;
            return category === 'completed' || category === 'canceled';
         }),
      [visible, issues]
   );

   return (
      <div className="flex h-full min-h-0 w-full">
         <div
            className={cn(
               'flex h-full min-h-0 w-full flex-col border-r bg-container md:w-[380px] md:shrink-0 lg:w-[420px]',
               selectedId ? 'hidden md:flex' : 'flex'
            )}
         >
            <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
               {(['active', 'archived'] as const).map((candidate) => (
                  <button
                     key={candidate}
                     type="button"
                     aria-current={view === candidate ? 'page' : undefined}
                     onClick={() => void setView(candidate === 'active' ? null : candidate)}
                     className={cn(
                        'inline-flex h-7 cursor-pointer items-center rounded-sm border px-3 font-medium transition-colors',
                        view === candidate
                           ? 'border-border/70 bg-accent text-foreground'
                           : 'border-border/40 text-muted-foreground hover:border-border/60 hover:bg-accent/50 hover:text-foreground'
                     )}
                  >
                     {t(`views.${candidate}`)}
                  </button>
               ))}
               <div className="ml-auto flex items-center gap-1">
                  <span className="hidden text-muted-foreground lg:inline">
                     {t('list.shortcutHint')}
                  </span>
                  <DropdownMenu>
                     <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="xs" aria-label={t('actions.bulkMenu')}>
                           <MoreHorizontal className="size-4" />
                        </Button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem
                           disabled={archivedView}
                           onSelect={() => {
                              void markAllAsRead().then((ok) => report(ok, t('toasts.allRead')));
                           }}
                        >
                           {t('actions.markAllRead')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                           disabled={archivedView || visible.length === 0}
                           onSelect={() => void sweep(visible)}
                        >
                           {t('actions.archiveAll')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                           disabled={archivedView}
                           onSelect={() => void sweep(visible.filter((item) => item.read))}
                        >
                           {t('actions.archiveRead')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                           disabled={archivedView || completedItems.length === 0}
                           onSelect={() => void sweep(completedItems)}
                        >
                           {t('actions.archiveCompleted')}
                        </DropdownMenuItem>
                     </DropdownMenuContent>
                  </DropdownMenu>
               </div>
            </div>

            <InboxFilterBar
               items={source}
               facetsOf={facetsOf}
               filters={filters}
               onChange={setFilters}
               senderName={senderName}
            />

            <div className="min-h-0 flex-1 overflow-y-auto">
               <InboxList
                  items={visible}
                  sourceCount={source.length}
                  ready={listReady}
                  failed={archivedView && archivedStatus === 'error'}
                  archivedView={archivedView}
                  filtered={hasActiveFilters(filters)}
                  selectedId={selectedId}
                  orgId={orgId}
                  senderName={senderName}
                  onSelect={(id) => void setSelectedId(id)}
                  onToggleRead={(item) => {
                     void (item.read ? markAsUnread(item.id) : markAsRead(item.id));
                  }}
                  onMoveOut={(item) => void moveOut(item)}
                  onClearFilters={() => setFilters(EMPTY_INBOX_FILTERS)}
                  onRetry={() => void loadArchive()}
               />
            </div>
         </div>

         <div
            className={cn(
               'h-full min-h-0 flex-1 flex-col bg-container',
               selectedId ? 'flex' : 'hidden md:flex'
            )}
         >
            <InboxDetail
               item={selected}
               archived={archivedView}
               orgId={orgId}
               onArchive={() => {
                  if (selected) void moveOut(selected);
               }}
               onUnarchive={() => {
                  if (selected) void moveOut(selected);
               }}
               onBack={() => void setSelectedId(null)}
            />
         </div>
      </div>
   );
}

interface InboxListProps {
   items: InboxItem[];
   sourceCount: number;
   ready: boolean;
   failed: boolean;
   archivedView: boolean;
   filtered: boolean;
   selectedId: string | null;
   orgId: string;
   senderName: (key: string) => string;
   onSelect: (id: string) => void;
   onToggleRead: (item: InboxItem) => void;
   onMoveOut: (item: InboxItem) => void;
   onClearFilters: () => void;
   onRetry: () => void;
}

function InboxList({
   items,
   sourceCount,
   ready,
   failed,
   archivedView,
   filtered,
   selectedId,
   orgId,
   senderName,
   onSelect,
   onToggleRead,
   onMoveOut,
   onClearFilters,
   onRetry,
}: InboxListProps) {
   const t = useTranslations('inbox');

   if (failed) {
      return (
         <InboxPanel
            state="crossed"
            title={t('states.error')}
            body={t('states.errorBody')}
            action={{ label: t('states.retry'), onClick: onRetry }}
         />
      );
   }
   if (!ready) return <InboxPanel title={t('states.loading')} />;
   if (items.length === 0) {
      if (sourceCount > 0 && filtered) {
         return (
            <InboxPanel
               title={t('states.noMatches')}
               action={{ label: t('filters.clear'), onClick: onClearFilters }}
            />
         );
      }
      return archivedView ? (
         <InboxPanel title={t('states.emptyArchive')} body={t('states.emptyArchiveBody')} />
      ) : (
         <InboxPanel title={t('states.empty')} body={t('states.emptyBody')} />
      );
   }

   return (
      <>
         {items.map((item) => (
            <InboxRow
               key={item.id}
               item={item}
               selected={item.id === selectedId}
               archived={archivedView}
               href={inboxHref(item, orgId)}
               sender={item.actor ? senderName(senderKey(item)) : null}
               onSelect={() => onSelect(item.id)}
               onToggleRead={() => onToggleRead(item)}
               onArchive={() => onMoveOut(item)}
               onUnarchive={() => onMoveOut(item)}
            />
         ))}
      </>
   );
}
