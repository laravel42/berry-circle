import React from 'react';
import {
   AtSign,
   CircleCheck,
   CircleSlash,
   Edit,
   GitPullRequest,
   Hand,
   MessageCircle,
   PauseCircle,
   Plus,
   RotateCcw,
   ShieldCheck,
   Smile,
   Sparkles,
   SquarePen,
   Target,
   Upload,
   UserMinus,
   UserPlus,
   X,
} from 'lucide-react';
import { NotificationType } from '@/data/inbox';
import { cn } from '@/lib/utils';

/**
 * The mark on a notification row.
 *
 * Colour comes from the semantic state tokens rather than raw palette values,
 * so the meaning survives both themes: agent work is `actor-agent`, a person's
 * is `actor-human`, and anything waiting on you or gone wrong takes the
 * warning and danger tones it would take anywhere else in the product.
 */
const TONE: Record<NotificationType, string> = {
   comment: 'text-actor-human',
   mention: 'text-status-warning',
   assignment: 'text-actor-human',
   unassigned: 'text-status-neutral',
   subscribed: 'text-status-neutral',
   fieldChange: 'text-status-neutral',
   reviewRequested: 'text-status-warning',
   reaction: 'text-actor-human',
   status: 'text-status-info',
   reopened: 'text-status-warning',
   closed: 'text-status-neutral',
   edited: 'text-status-neutral',
   created: 'text-status-info',
   upload: 'text-status-neutral',
   approval: 'text-status-warning',
   goal: 'text-status-info',
   workflow: 'text-actor-agent',
   plan: 'text-status-info',
   runCompleted: 'text-status-success',
   runFailed: 'text-status-danger',
   agentBlocked: 'text-status-warning',
   agentCompleted: 'text-status-success',
   autopilotPaused: 'text-status-neutral',
};

const ICON: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
   comment: MessageCircle,
   mention: AtSign,
   assignment: UserPlus,
   unassigned: UserMinus,
   subscribed: Target,
   fieldChange: SquarePen,
   reviewRequested: GitPullRequest,
   reaction: Smile,
   status: GitPullRequest,
   reopened: RotateCcw,
   closed: X,
   edited: Edit,
   created: Plus,
   upload: Upload,
   approval: ShieldCheck,
   goal: Target,
   workflow: Sparkles,
   plan: Sparkles,
   runCompleted: CircleCheck,
   runFailed: CircleSlash,
   agentBlocked: Hand,
   agentCompleted: CircleCheck,
   autopilotPaused: PauseCircle,
};

export function getNotificationIcon(type: NotificationType, className?: string) {
   const Icon = ICON[type] ?? MessageCircle;
   return <Icon className={cn(TONE[type] ?? 'text-status-neutral', className)} />;
}
