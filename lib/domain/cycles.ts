import { format, parseISO } from 'date-fns';

export type CycleStatus = 'planned' | 'upcoming' | 'current' | 'completed';

/** One data point of a cycle burn-up chart. */
export interface CycleBurnupPoint {
   date: string; // ISO date (yyyy-MM-dd)
   scope: number;
   started: number;
   completed: number;
   ideal: number;
}

export interface Cycle {
   id: string;
   number: number;
   name: string;
   teamId: string;
   status: CycleStatus;
   startDate: string; // ISO date
   endDate: string; // ISO date
   /** Percentage of the team capacity currently allocated to the cycle. */
   capacity: number;
   /** Total number of issues in the cycle. */
   scope: number;
   /** Scope variation (in %) since the beginning of the cycle. */
   scopeDelta: number;
   /** Number of issues started but not completed. */
   started: number;
   /** Number of completed issues. */
   completed: number;
   /** Completed / scope, for finished cycles ("67% success"). */
   successRate?: number;
   /** Burn-up chart points (only meaningful for current / completed cycles). */
   burnup?: CycleBurnupPoint[];
}

/** Populated via the gateway API at runtime. */
export const cycles: Cycle[] = [];

export function getCurrentCycle(): Cycle {
   return cycles[0] as unknown as Cycle;
}

export function getUpcomingCycle(): Cycle {
   return cycles[0] as unknown as Cycle;
}

export function getCycleById(id: string): Cycle | undefined {
   return cycles.find((c) => c.id === id);
}

export function getCyclesByTeam(teamId: string): Cycle[] {
   return cycles.filter((c) => c.teamId === teamId);
}

export function formatCycleDateRange(cycle: Cycle): string {
   return `${format(parseISO(cycle.startDate), 'MMM d')} → ${format(parseISO(cycle.endDate), 'MMM d')}`;
}

export const cycleStatusLabel: Record<CycleStatus, string> = {
   planned: 'Planned',
   upcoming: 'Upcoming',
   current: 'Current',
   completed: 'Completed',
};
