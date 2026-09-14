'use client';

import { cn } from '@/lib/utils';

interface ActivityPoint {
   /** `YYYY-MM-DD`, UTC. */
   day: string;
   runs: number;
   failed: number;
}

interface AgentSparklineProps {
   activity: ActivityPoint[];
   /** Per-day tooltip, already formatted by the caller's message catalogue. */
   describe: (point: ActivityPoint & { percent: number }) => string;
   /** What a row with no runs at all says. */
   emptyLabel: string;
   className?: string;
}

const HEIGHT = 20;
const BAR = 4;
const GAP = 2;

/**
 * Seven days of runs as one small column chart.
 *
 * Failures are drawn as the bottom of each column rather than as a second
 * series: the question a reader brings to this cell is "is this agent working,
 * and is its work landing", and two overlapping lines answer neither at this
 * size. A day with no runs still gets a baseline tick, so the gaps read as
 * "nothing happened" instead of as missing data.
 *
 * Tooltips are SVG `<title>` elements, one per column. They need no JavaScript,
 * they survive a table that re-renders under the pointer, and a screen reader
 * gets the same numbers from the group label.
 */
export function AgentSparkline({ activity, describe, emptyLabel, className }: AgentSparklineProps) {
   const width = activity.length * BAR + Math.max(0, activity.length - 1) * GAP;
   const peak = Math.max(1, ...activity.map((point) => point.runs));
   const total = activity.reduce((sum, point) => sum + point.runs, 0);

   if (total === 0) {
      return (
         <span
            className={cn('inline-flex items-center text-muted-foreground', className)}
            title={emptyLabel}
         >
            <svg
               width={width}
               height={HEIGHT}
               viewBox={`0 0 ${width} ${HEIGHT}`}
               role="img"
               aria-label={emptyLabel}
            >
               {activity.map((point, index) => (
                  <rect
                     key={point.day}
                     x={index * (BAR + GAP)}
                     y={HEIGHT - 1}
                     width={BAR}
                     height={1}
                     className="fill-muted-foreground/30"
                  />
               ))}
            </svg>
         </span>
      );
   }

   return (
      <span className={cn('inline-flex items-center', className)}>
         <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={activity
               .map((point) =>
                  describe({
                     ...point,
                     percent: point.runs === 0 ? 0 : Math.round((point.failed / point.runs) * 100),
                  })
               )
               .join('. ')}
         >
            {activity.map((point, index) => {
               const full = Math.max(1, Math.round((point.runs / peak) * (HEIGHT - 2)));
               const failed =
                  point.failed === 0
                     ? 0
                     : Math.max(1, Math.round((point.failed / peak) * (HEIGHT - 2)));
               const x = index * (BAR + GAP);
               const label = describe({
                  ...point,
                  percent: point.runs === 0 ? 0 : Math.round((point.failed / point.runs) * 100),
               });
               return (
                  <g key={point.day}>
                     <title>{label}</title>
                     <rect
                        x={x}
                        y={HEIGHT - full}
                        width={BAR}
                        height={full}
                        rx={1}
                        className={
                           point.runs === 0 ? 'fill-muted-foreground/30' : 'fill-primary/70'
                        }
                     />
                     {failed > 0 ? (
                        <rect
                           x={x}
                           y={HEIGHT - failed}
                           width={BAR}
                           height={failed}
                           rx={1}
                           className="fill-destructive"
                        />
                     ) : null}
                  </g>
               );
            })}
         </svg>
      </span>
   );
}
