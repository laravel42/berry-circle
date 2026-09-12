'use client';

import {
   ContextMenu,
   ContextMenuContent,
   ContextMenuItem,
   ContextMenuSeparator,
   ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { InboxItem } from '@/data/inbox';
import { getNotificationIcon } from '@/lib/notification-utils';
import { cn } from '@/lib/utils';
import {
   Archive,
   ArchiveRestore,
   ExternalLink,
   Mail,
   MailOpen,
   MoreHorizontal,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { relativeTime } from './inbox-format';

export interface InboxRowActions {
   onSelect: () => void;
   onToggleRead: () => void;
   onArchive: () => void;
   onUnarchive: () => void;
}

interface InboxRowProps extends InboxRowActions {
   item: InboxItem;
   selected: boolean;
   /** The archive shows "move back" where the inbox shows "archive". */
   archived: boolean;
   /** Where the row opens in its own tab, when it points at a record. */
   href: string | null;
   /** Who sent it, already resolved to a name. */
   sender: string | null;
}

/**
 * One notification in the list.
 *
 * The same four actions are reachable three ways — the menu button, a
 * right-click, and the controls that appear on hover — because which one a
 * reader reaches for depends entirely on whether they are already holding the
 * mouse still over the row.
 */
export function InboxRow({
   item,
   selected,
   archived,
   href,
   sender,
   onSelect,
   onToggleRead,
   onArchive,
   onUnarchive,
}: InboxRowProps) {
   const t = useTranslations('inbox');
   const readLabel = item.read ? t('actions.markUnread') : t('actions.markRead');
   const archiveLabel = archived ? t('actions.unarchive') : t('actions.archive');
   const onArchiveAction = archived ? onUnarchive : onArchive;

   const actions = (
      <>
         <ContextMenuItem onSelect={onToggleRead}>
            {item.read ? <Mail /> : <MailOpen />}
            {readLabel}
         </ContextMenuItem>
         <ContextMenuItem onSelect={onArchiveAction}>
            {archived ? <ArchiveRestore /> : <Archive />}
            {archiveLabel}
         </ContextMenuItem>
         {href ? (
            <>
               <ContextMenuSeparator />
               <ContextMenuItem asChild>
                  <a href={href} target="_blank" rel="noreferrer">
                     <ExternalLink />
                     {t('actions.openInNewTab')}
                  </a>
               </ContextMenuItem>
            </>
         ) : null}
      </>
   );

   return (
      <ContextMenu>
         <ContextMenuTrigger asChild>
            <div
               data-inbox-row={item.id}
               className={cn(
                  'group relative flex w-full items-start border-b border-border/50',
                  selected ? 'bg-accent' : 'hover:bg-sidebar/50'
               )}
            >
               <button
                  type="button"
                  onClick={onSelect}
                  aria-current={selected ? 'true' : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 px-4 py-3 text-left"
               >
                  <span className="mt-0.5 shrink-0">
                     {getNotificationIcon(item.type, 'size-4')}
                  </span>
                  <span className="min-w-0 flex-1">
                     <span className="flex min-w-0 items-center gap-1.5">
                        {item.identifier ? (
                           <span className="shrink-0 text-muted-foreground">{item.identifier}</span>
                        ) : null}
                        <span className={cn('truncate', item.read ? 'font-normal' : 'font-medium')}>
                           {item.title}
                        </span>
                     </span>
                     {item.content && item.content !== item.title ? (
                        <span className="mt-0.5 line-clamp-2 text-muted-foreground">
                           {item.content}
                        </span>
                     ) : null}
                     <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
                        <span>{t(`types.${item.type}`)}</span>
                        {sender ? (
                           <>
                              <span aria-hidden="true">·</span>
                              <span className="truncate">{sender}</span>
                           </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>{relativeTime(item.timestamp)}</span>
                     </span>
                  </span>
                  {item.read ? null : (
                     <span
                        aria-label={t('list.unread')}
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                     />
                  )}
               </button>

               {/* Hover controls, and the menu that is always there. Hidden
                   until the row is hovered or something inside it has focus,
                   so a keyboard reader can still reach them. */}
               <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                     type="button"
                     onClick={onToggleRead}
                     aria-label={readLabel}
                     title={readLabel}
                     className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                     {item.read ? <Mail className="size-3.5" /> : <MailOpen className="size-3.5" />}
                  </button>
                  <button
                     type="button"
                     onClick={onArchiveAction}
                     aria-label={archiveLabel}
                     title={archiveLabel}
                     className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                     {archived ? (
                        <ArchiveRestore className="size-3.5" />
                     ) : (
                        <Archive className="size-3.5" />
                     )}
                  </button>
                  <DropdownMenu>
                     <DropdownMenuTrigger asChild>
                        <button
                           type="button"
                           aria-label={t('actions.rowMenu')}
                           className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                           <MoreHorizontal className="size-3.5" />
                        </button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onSelect={onToggleRead}>
                           {item.read ? <Mail /> : <MailOpen />}
                           {readLabel}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={onArchiveAction}>
                           {archived ? <ArchiveRestore /> : <Archive />}
                           {archiveLabel}
                        </DropdownMenuItem>
                        {href ? (
                           <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                 <a href={href} target="_blank" rel="noreferrer">
                                    <ExternalLink />
                                    {t('actions.openInNewTab')}
                                 </a>
                              </DropdownMenuItem>
                           </>
                        ) : null}
                     </DropdownMenuContent>
                  </DropdownMenu>
               </div>
            </div>
         </ContextMenuTrigger>
         <ContextMenuContent className="w-52">{actions}</ContextMenuContent>
      </ContextMenu>
   );
}
