'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { loadSubscribers, setSubscription, type Subscriber } from '@/lib/subscribers';
import { Bell, BellOff, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Who hears about this task.
 *
 * The count alone ("4 following") is the least useful true statement the page
 * could make: the question a person actually has is whether *they* will hear
 * about it, and after that, who else will. So the button says what it will do
 * to them, and the popover names the rest.
 */
export function IssueSubscription({ issueRef }: { issueRef: string }) {
   const t = useTranslations('issueDetail.subscription');
   const [state, setState] = useState<{ nodes: Subscriber[]; subscribed: boolean }>({
      nodes: [],
      subscribed: false,
   });
   const [busy, setBusy] = useState(false);

   const reload = useCallback(() => {
      void loadSubscribers(issueRef)
         .then(setState)
         .catch(() => undefined);
   }, [issueRef]);
   useEffect(reload, [reload]);

   const change = (subscribed: boolean, subtree: boolean) => {
      setBusy(true);
      void setSubscription(issueRef, subscribed, subtree)
         .then(reload)
         .catch(() => toast.error(t('changeFailed')))
         .finally(() => setBusy(false));
   };

   return (
      <div className="flex items-center gap-1">
         <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => change(!state.subscribed, false)}
         >
            {state.subscribed ? (
               <BellOff className="mr-1 size-3.5" />
            ) : (
               <Bell className="mr-1 size-3.5" />
            )}
            {state.subscribed ? t('unsubscribe') : t('subscribe')}
         </Button>

         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button variant="ghost" size="icon" className="size-8" aria-label={t('edit')}>
                  <ChevronDown className="size-3.5" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               <DropdownMenuItem onClick={() => change(true, true)}>
                  {t('subtreeSubscribe')}
               </DropdownMenuItem>
               <DropdownMenuItem onClick={() => change(false, true)}>
                  {t('subtreeUnsubscribe')}
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>

         <Popover>
            <PopoverTrigger asChild>
               <Button variant="ghost" size="xs" className="text-muted-foreground">
                  {t('following', { count: state.nodes.length })}
               </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
               <div className="mb-1.5 font-medium">{t('title')}</div>
               {state.nodes.length === 0 ? (
                  <p className="text-muted-foreground">{t('empty')}</p>
               ) : (
                  <ul className="flex max-h-64 flex-col overflow-y-auto">
                     {state.nodes.map((subscriber) => (
                        <li
                           key={subscriber.userId}
                           className="flex min-w-0 items-center gap-2 py-1"
                        >
                           <Avatar className="size-5 shrink-0">
                              <AvatarImage
                                 src={subscriber.avatarUrl ?? undefined}
                                 alt={subscriber.name ?? ''}
                              />
                              <AvatarFallback>{(subscriber.name ?? '?')[0]}</AvatarFallback>
                           </Avatar>
                           <span className="min-w-0 flex-1 truncate">
                              {subscriber.name ?? subscriber.userId}
                           </span>
                           <span className="shrink-0 text-muted-foreground">
                              {subscriber.reason}
                           </span>
                        </li>
                     ))}
                  </ul>
               )}
               <Button
                  variant="ghost"
                  size="xs"
                  className="mt-1.5 w-full justify-start"
                  disabled={busy}
                  onClick={() => change(false, true)}
               >
                  {t('subtreeUnsubscribe')}
               </Button>
            </PopoverContent>
         </Popover>
      </div>
   );
}
