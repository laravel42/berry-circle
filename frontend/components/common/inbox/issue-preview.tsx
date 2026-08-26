'use client';

import { ContentBlocks } from '@/components/common/issues/details/content-blocks';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { IssuePropertiesPanel } from '@/components/common/issues/details/issue-properties-panel';
import { LabelBadge } from '@/components/common/issues/label-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getNotificationIcon } from '@/lib/notification-utils';
import { getIssueDetail } from '@/data/issue-details';
import { InboxItem } from '@/data/inbox';
import { useIssuesStore } from '@/store/issues-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { ArrowUpRight, Check, Paperclip, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { NotificationBox } from './icons/motification-box';
import { WORKSPACE_SLUG } from '@/lib/config';
import { InboxEntityPreview, inboxEntityHref } from './entity-preview';

interface IssuePreviewProps {
   notification?: InboxItem;
   onMarkAsRead?: (id: string) => void;
}

/** ISO from the API; falls back to the raw string rather than throwing. */
function relativeTime(value: string): string {
   try {
      return formatDistanceToNow(parseISO(value), { addSuffix: true });
   } catch {
      return value;
   }
}

/**
 * Inbox preview pane: the REAL record behind the selected notification — the
 * task with its live status and rich description, or the approval, goal,
 * plan or run the notification is about — plus the notification context.
 */
export default function IssuePreview({ notification, onMarkAsRead }: IssuePreviewProps) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { getUnreadCount } = useNotificationsStore();
   const { issues } = useIssuesStore();

   if (!notification) {
      const unreadCount = getUnreadCount();

      return (
         <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <NotificationBox className="w-16 h-16 mb-4 text-muted-foreground/50" />
            <h3 className="font-semibold text-muted-foreground mb-2">
               {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
            </h3>
            <p className="text-muted-foreground max-w-sm">
               Select a notification from the list to view its details and take action.
            </p>
         </div>
      );
   }

   // Live task from the store (falls back to the notification's snapshot).
   const snapshot = notification.issue;
   const issue = snapshot
      ? issues.find(
           (candidate) =>
              candidate.id === snapshot.id ||
              (snapshot.identifier !== '' && candidate.identifier === snapshot.identifier)
        )
      : undefined;
   const displayIssue = issue ?? snapshot;
   const detail = displayIssue ? getIssueDetail(displayIssue) : undefined;
   const openHref = inboxEntityHref(notification, orgId);

   return (
      <div className="flex flex-col h-full overflow-hidden">
         {/* Header */}
         <div className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0">
            <div className="flex items-center gap-2 min-w-0">
               {displayIssue ? (
                  <>
                     <displayIssue.status.icon />
                     <span className="font-medium truncate">{displayIssue.identifier}</span>
                  </>
               ) : (
                  <>
                     {getNotificationIcon(notification.type, 'size-4')}
                     <span className="font-medium truncate capitalize">
                        {notification.category}
                     </span>
                  </>
               )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
               {!notification.read && onMarkAsRead && (
                  <Button
                     variant="outline"
                     size="xs"
                     onClick={() => onMarkAsRead(notification.id)}
                     className="gap-1"
                  >
                     <Check className="size-4" />
                     Mark as read
                  </Button>
               )}
               {openHref && (
                  <Button variant="ghost" size="xs" asChild>
                     <Link href={openHref}>
                        Open
                        <ArrowUpRight className="size-3.5 ml-0.5" />
                     </Link>
                  </Button>
               )}
            </div>
         </div>

         {/* Real record + properties column (Linear-style) */}
         <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 overflow-y-auto">
               <div className="pt-8 pb-6 px-6 w-full max-w-3xl mx-auto">
                  {/* Notification context */}
                  <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg mb-8">
                     <div className="relative shrink-0">
                        <Avatar className="size-7">
                           <AvatarImage
                              src={notification.user.avatarUrl}
                              alt={notification.user.name}
                           />
                           <AvatarFallback>{notification.user.name[0]}</AvatarFallback>
                        </Avatar>
                        <div className="absolute -bottom-1 -right-1 size-4 rounded-full bg-accent border border-background flex items-center justify-center">
                           {getNotificationIcon(notification.type, 'size-2.5')}
                        </div>
                     </div>
                     <div className="min-w-0">
                        <span className="font-medium">{notification.user.name}</span>{' '}
                        <span className="text-muted-foreground">
                           · {relativeTime(notification.timestamp)}
                        </span>
                        <p className="text-foreground/90 mt-0.5">{notification.content}</p>
                     </div>
                  </div>

                  {displayIssue && detail ? (
                     <>
                        <h3 className="font-semibold text-foreground text-balance">
                           {displayIssue.title}
                        </h3>

                        {/* Properties row */}
                        <div className="flex items-center flex-wrap gap-x-4 gap-y-2 mt-4 xl:hidden">
                           <span className="flex items-center gap-1.5">
                              <displayIssue.status.icon />
                              {displayIssue.status.name}
                           </span>
                           <span className="flex items-center gap-1.5 text-muted-foreground">
                              <displayIssue.priority.icon className="size-3.5" />
                              {displayIssue.priority.name}
                           </span>
                           {displayIssue.assignee && (
                              <span className="flex items-center gap-1.5">
                                 <Avatar className="size-4">
                                    <AvatarImage
                                       src={displayIssue.assignee.avatarUrl}
                                       alt={displayIssue.assignee.name}
                                    />
                                    <AvatarFallback>{displayIssue.assignee.name[0]}</AvatarFallback>
                                 </Avatar>
                                 {displayIssue.assignee.name}
                              </span>
                           )}
                           <LabelBadge label={displayIssue.labels} />
                        </div>

                        {/* Real description */}
                        <div className="mt-6">
                           <ContentBlocks blocks={detail.description} />
                        </div>

                        {/* Comment composer */}
                        <div className="relative w-full flex flex-col mt-10">
                           <Textarea
                              className="w-full rounded-lg border px-4 py-3 text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-accent pb-14 resize-none"
                              placeholder="Leave a comment..."
                              rows={3}
                           />
                           <div className="absolute right-3 bottom-3 flex items-center gap-3">
                              <Button size="icon" variant="ghost">
                                 <Paperclip className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="secondary">
                                 <Send className="w-4 h-4" />
                              </Button>
                           </div>
                        </div>
                     </>
                  ) : (
                     <InboxEntityPreview notification={notification} />
                  )}
               </div>
            </div>

            {issue && detail && (
               <aside className="hidden xl:block w-64 shrink-0 border-l overflow-y-auto bg-container px-4 py-5">
                  <IssuePropertiesPanel issue={issue} detail={detail} />
               </aside>
            )}
         </div>
      </div>
   );
}
