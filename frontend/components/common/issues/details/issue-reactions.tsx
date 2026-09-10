'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { loadReactions, QUICK_EMOJI, toggleReaction, type ReactionGroup } from '@/lib/reactions';
import { cn } from '@/lib/utils';
import { SmilePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Reaction chips for a task or a comment, plus a small picker. */
export function ReactionBar({ target, id }: { target: 'issue' | 'comment'; id: string }) {
   const [groups, setGroups] = useState<ReactionGroup[]>([]);

   useEffect(() => {
      if (!id) return;
      let cancelled = false;
      void loadReactions(target, id)
         .then((loaded) => !cancelled && setGroups(loaded))
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [target, id]);

   const toggle = (emoji: string) => {
      const reacted = groups.find((group) => group.emoji === emoji)?.reactedByMe ?? false;
      void toggleReaction(target, id, emoji, reacted)
         .then(setGroups)
         .catch(() => toast.error('The reaction could not be saved.'));
   };

   return (
      <div className="flex flex-wrap items-center gap-1.5">
         {groups.map((group) => (
            <button
               key={group.emoji}
               type="button"
               onClick={() => toggle(group.emoji)}
               aria-pressed={group.reactedByMe}
               className={cn(
                  'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
                  group.reactedByMe ? 'bg-accent' : 'bg-transparent'
               )}
            >
               {group.emoji} {group.count}
            </button>
         ))}
         <Popover>
            <PopoverTrigger asChild>
               <Button variant="ghost" size="icon" className="size-7" aria-label="Add reaction">
                  <SmilePlus className="size-4" />
               </Button>
            </PopoverTrigger>
            <PopoverContent className="flex w-auto gap-1 p-1.5" align="start">
               {QUICK_EMOJI.map((emoji) => (
                  <button key={emoji} type="button" className="rounded px-1.5 py-1 hover:bg-accent" onClick={() => toggle(emoji)}>
                     {emoji}
                  </button>
               ))}
            </PopoverContent>
         </Popover>
      </div>
   );
}

export function IssueReactions({ issueRef }: { issueRef: string }) {
   return <ReactionBar target="issue" id={issueRef} />;
}
