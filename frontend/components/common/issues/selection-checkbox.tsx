'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useIssueSelectionStore } from '@/store/issue-selection-store';

/**
 * The select box on a row or a card.
 *
 * It stays out of the way until the row is hovered or something is already
 * selected, and a shift-click takes everything between the last plain click
 * and this one, in the order the list is showing — which is why the caller
 * hands over that order rather than the component guessing it.
 */
export function SelectionCheckbox({
   issueId,
   order,
   className,
}: {
   issueId: string;
   order: string[];
   className?: string;
}) {
   const { selected, toggle, selectRange } = useIssueSelectionStore();
   const checked = selected.includes(issueId);
   const anySelected = selected.length > 0;

   return (
      <span
         className="flex shrink-0 items-center"
         onClick={(event) => event.stopPropagation()}
         role="presentation"
      >
         <Checkbox
            checked={checked}
            aria-label="Select task"
            className={cn(
               'size-3.5 transition-opacity',
               checked || anySelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
               className
            )}
            onClick={(event) => {
               if (!event.shiftKey) return;
               // The range replaces the plain toggle this click would have
               // caused, so the change handler must not also run.
               event.preventDefault();
               selectRange(issueId, order);
            }}
            onCheckedChange={() => toggle(issueId)}
         />
      </span>
   );
}
