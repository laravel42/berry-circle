import type React from 'react';

import { BerryMark, type BerryMarkState, type BerryMarkTone } from '@/components/brand/berry-mark';

export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface Status {
   id: string;
   name: string;
   color: string;
   category: StatusCategory;
   icon: React.FC;
}

function statusIcon(
   tone: BerryMarkTone,
   options: { pulse?: boolean; state?: BerryMarkState; label: string }
): React.FC {
   const Icon = () => (
      <BerryMark
         size="sm"
         tone={tone}
         state={options.state}
         pulse={options.pulse}
         label={options.label}
      />
   );
   return Icon;
}

export const BacklogIcon = statusIcon('neutral', { state: 'hollow', label: 'Backlog' });
export const ToDoIcon = statusIcon('neutral', { state: 'hollow', label: 'Todo' });
export const InProgressIcon = statusIcon('working', { pulse: true, label: 'In Progress' });
export const InReviewIcon = statusIcon('attention', { label: 'In Review' });
export const DoneIcon = statusIcon('complete', { label: 'Done' });
export const BlockedIcon = statusIcon('attention', { state: 'hollow', label: 'Blocked' });
export const CancelledIcon = statusIcon('attention', { state: 'crossed', label: 'Cancelled' });
/** Project-only workflow state (not an issue status). */
export const PausedIcon = statusIcon('neutral', { state: 'hollow', label: 'Paused' });

/**
 * Berry issue workflow statuses in board/list order.
 * IDs stay stable for UI state; API mapping lives in `lib/catalog.ts`.
 */
/** Circle board palette — header tints derive from these hex values. */
export const status: Status[] = [
   {
      id: 'backlog',
      name: 'Backlog',
      color: '#95a2b3',
      category: 'backlog',
      icon: BacklogIcon,
   },
   {
      id: 'to-do',
      name: 'Todo',
      color: '#99a2b2',
      category: 'unstarted',
      icon: ToDoIcon,
   },
   {
      id: 'in-progress',
      name: 'In Progress',
      color: '#facc15',
      category: 'started',
      icon: InProgressIcon,
   },
   {
      id: 'in-review',
      name: 'In Review',
      color: '#22c55e',
      category: 'started',
      icon: InReviewIcon,
   },
   {
      id: 'done',
      name: 'Done',
      color: '#5e6ad2',
      category: 'completed',
      icon: DoneIcon,
   },
   {
      id: 'blocked',
      name: 'Blocked',
      color: '#eb5757',
      category: 'started',
      icon: BlockedIcon,
   },
   {
      id: 'cancelled',
      name: 'Cancelled',
      color: '#8f9299',
      category: 'canceled',
      icon: CancelledIcon,
   },
];

/** Same order as `status` — used by list, board, insights, and filters. */
export const workflowOrderedStatus: Status[] = status;

export const displayOrderedStatus: Status[] = status;

export function getStatusesByCategory(categories: StatusCategory[]): Status[] {
   return status.filter((item) => categories.includes(item.category));
}

export const StatusIcon: React.FC<{ statusId: string }> = ({ statusId }) => {
   const currentStatus = status.find((item) => item.id === statusId);
   if (!currentStatus) return null;

   const IconComponent = currentStatus.icon;
   return <IconComponent />;
};
