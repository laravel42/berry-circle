'use client';

import { StatusBadge } from '@/components/common/workflows/workflow-status-badge';
import { GOAL_STATUS, statusLook } from '@/lib/catalog';

export function GoalStatusBadge({ status, className }: { status: string; className?: string }) {
   return <StatusBadge look={statusLook(GOAL_STATUS, status)} className={className} />;
}
