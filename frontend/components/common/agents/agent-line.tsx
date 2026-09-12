'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle, MoreHorizontal } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { BerryMark } from '@/components/brand/berry-mark';
import { Checkbox } from '@/components/ui/checkbox';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
   agentModelDisplay,
   agentStatusDisplay,
   useAgentAvatarSrc,
   type Agent,
   type AgentRoster,
} from '@/lib/agents';
import type { AgentColumn } from '@/store/agents-list-store';
import { AgentSparkline } from './agent-sparkline';

export interface AgentRowActions {
   onDuplicate: (agent: Agent) => void;
   onCancelRuns: (agent: Agent) => void;
   onArchive: (agent: Agent) => void;
   onRestore: (agent: Agent) => void;
}

interface AgentLineProps {
   agent: Agent;
   /** Load, runtime and recent activity; absent while the roster is loading. */
   roster: AgentRoster | undefined;
   columns: AgentColumn[];
   selected: boolean;
   onToggleSelected: (id: string) => void;
   actions: AgentRowActions;
}

/** The widths every cell shares with its header, so the two line up. */
export const COLUMN_WIDTH: Record<AgentColumn, string> = {
   presence: 'w-24',
   workload: 'w-24',
   runtime: 'w-32',
   activity: 'w-20',
   runs: 'w-14',
   lastActive: 'w-28',
   model: 'w-40',
   owner: 'w-28',
   access: 'w-28',
};

/** Columns that drop out before the row starts crowding the name. */
export const COLUMN_BREAKPOINT: Partial<Record<AgentColumn, string>> = {
   runtime: 'hidden lg:flex',
   activity: 'hidden md:flex',
   lastActive: 'hidden lg:flex',
   model: 'hidden xl:flex',
   owner: 'hidden xl:flex',
   access: 'hidden 2xl:flex',
};

function Cell({
   column,
   columns,
   className,
   children,
}: {
   column: AgentColumn;
   columns: AgentColumn[];
   className?: string;
   children: React.ReactNode;
}) {
   if (!columns.includes(column)) return null;
   return (
      <div
         className={cn(
            'shrink-0 items-center gap-1.5 text-muted-foreground',
            COLUMN_WIDTH[column],
            COLUMN_BREAKPOINT[column] ?? 'flex',
            className
         )}
      >
         {children}
      </div>
   );
}

export default function AgentLine({
   agent,
   roster,
   columns,
   selected,
   onToggleSelected,
   actions,
}: AgentLineProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const t = useTranslations('agentsChat.list');
   const format = useFormatter();
   const [hovered, setHovered] = useState(false);
   const status = agentStatusDisplay(agent.status);
   const model = agentModelDisplay(agent);
   const avatarSrc = useAgentAvatarSrc(agent.avatarUrl);
   const href = `/${orgId}/agents/${agent.id}`;
   const archived = Boolean(agent.archivedAt);
   // The orchestrator is the one agent a workspace cannot do without, and the
   // server refuses to archive it. Saying so here beats a 409 after the click.
   const isProtected = agent.capabilities.includes('orchestrate');

   const workload = roster
      ? roster.running > 0
         ? t('workloadWorking')
         : roster.queued > 0
           ? t('workloadQueued', { count: roster.queued })
           : t('workloadIdle')
      : '';

   const runtimeStatusLabel =
      roster?.runtimeStatus === 'active'
         ? t('runtimeHealthy')
         : roster?.runtimeStatus === 'unreachable'
           ? t('runtimeUnreachable')
           : roster?.runtimeStatus === 'disabled'
             ? t('runtimeDisabled')
             : '';

   const accessLabel =
      agent.access?.assign === 'admins'
         ? t('accessAdmins')
         : agent.access?.assign === 'listed'
           ? t('accessListed')
           : t('accessEveryone');

   return (
      <div
         className={cn(
            'group flex w-full items-center gap-3 border-b border-muted-foreground/5 px-6 py-3',
            'last:border-b-0 hover:bg-sidebar/50',
            selected && 'bg-sidebar/60'
         )}
      >
         <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelected(agent.id)}
            aria-label={t('select', { name: agent.name })}
            className="shrink-0"
         />

         <Popover open={hovered} onOpenChange={setHovered}>
            <PopoverTrigger asChild>
               <Link
                  href={href}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  onFocus={() => setHovered(true)}
                  onBlur={() => setHovered(false)}
                  className="flex min-w-0 flex-1 items-center gap-2.5"
               >
                  <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                     {avatarSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a blob or external URL, not an optimisable asset
                        <img src={avatarSrc} alt="" className="size-full object-cover" />
                     ) : (
                        <BerryMark size="sm" tone="working" label={agent.name} />
                     )}
                  </span>
                  <div className="min-w-0 overflow-hidden">
                     <span className="truncate font-medium leading-none">{agent.name}</span>
                     {agent.description ? (
                        <p className="mt-0.5 line-clamp-1 text-muted-foreground">
                           {agent.description}
                        </p>
                     ) : null}
                  </div>
               </Link>
            </PopoverTrigger>
            <PopoverContent
               align="start"
               side="bottom"
               // A hover card, not a menu: it never takes focus away from the
               // row, so a pointer moving down the list does not steal the
               // keyboard from whoever is tabbing through it.
               onOpenAutoFocus={(event) => event.preventDefault()}
               className="w-80"
            >
               <p className="font-medium">{agent.name}</p>
               {agent.description ? (
                  <p className="mt-1 text-muted-foreground">{agent.description}</p>
               ) : null}
               <p className="mt-3 text-muted-foreground">{t('hoverInstructions')}</p>
               <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap">
                  {agent.instructions?.trim() || t('hoverNoInstructions')}
               </p>
               <p className="mt-3 text-muted-foreground">{t('hoverSkills')}</p>
               <div className="mt-1 flex flex-wrap gap-1">
                  {agent.capabilities.length === 0 ? (
                     <span className="text-muted-foreground">{t('hoverNoSkills')}</span>
                  ) : (
                     agent.capabilities.slice(0, 8).map((skill) => (
                        <span
                           key={skill}
                           className="rounded-md border border-border/70 px-1.5 py-0.5"
                        >
                           {skill}
                        </span>
                     ))
                  )}
               </div>
               <Link href={href} className="mt-3 inline-block underline-offset-2 hover:underline">
                  {t('hoverOpen')}
               </Link>
            </PopoverContent>
         </Popover>

         <Cell column="presence" columns={columns}>
            <span
               className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  status.tone === 'online' && 'bg-[#00cc66]',
                  status.tone === 'busy' && 'bg-amber-500',
                  (status.tone === 'offline' || status.tone === 'unknown') &&
                     'bg-muted-foreground/40'
               )}
            />
            <span className="truncate">
               {status.tone === 'online'
                  ? t('availabilityAvailable')
                  : status.tone === 'busy'
                    ? t('availabilityBusy')
                    : status.tone === 'offline'
                      ? t('availabilityOffline')
                      : t('availabilityUnknown')}
            </span>
         </Cell>

         <Cell column="workload" columns={columns}>
            <span className="truncate">{workload}</span>
         </Cell>

         <Cell column="runtime" columns={columns}>
            {roster?.runtimeId ? (
               <span className="truncate" title={runtimeStatusLabel}>
                  {roster.runtimeName}
               </span>
            ) : roster ? (
               <span className="inline-flex items-center gap-1.5 truncate text-amber-500">
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                  {t('runtimeNone')}
               </span>
            ) : null}
         </Cell>

         <Cell column="activity" columns={columns}>
            {roster ? (
               <AgentSparkline
                  activity={roster.activity}
                  emptyLabel={t('sparkEmpty')}
                  describe={(point) =>
                     t('sparkTooltip', {
                        day: point.day,
                        runs: point.runs,
                        failed: point.failed,
                        percent: point.percent,
                     })
                  }
               />
            ) : null}
         </Cell>

         <Cell column="runs" columns={columns} className="justify-end tabular-nums">
            {roster ? roster.totalRuns : null}
         </Cell>

         <Cell column="lastActive" columns={columns}>
            <span className="truncate">
               {roster?.lastActiveAt
                  ? format.relativeTime(new Date(roster.lastActiveAt))
                  : roster
                    ? t('lastActiveNever')
                    : ''}
            </span>
         </Cell>

         <Cell column="model" columns={columns}>
            <span className="truncate" title={model.title}>
               {model.label}
            </span>
         </Cell>

         <Cell column="owner" columns={columns}>
            <span className="truncate">{roster?.ownerName ?? t('ownerWorkspace')}</span>
         </Cell>

         <Cell column="access" columns={columns}>
            <span className="truncate">{accessLabel}</span>
         </Cell>

         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <button
                  type="button"
                  aria-label={t('menuActions', { name: agent.name })}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
               >
                  <MoreHorizontal className="size-4" />
               </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
               <DropdownMenuItem onSelect={() => window.open(href, '_blank', 'noopener')}>
                  {t('menuOpenNewTab')}
               </DropdownMenuItem>
               <DropdownMenuItem onSelect={() => actions.onDuplicate(agent)}>
                  {t('menuDuplicate')}
               </DropdownMenuItem>
               <DropdownMenuSeparator />
               {archived ? (
                  <DropdownMenuItem onSelect={() => actions.onRestore(agent)}>
                     {t('menuRestore')}
                  </DropdownMenuItem>
               ) : (
                  <>
                     <DropdownMenuItem onSelect={() => actions.onCancelRuns(agent)}>
                        {t('menuCancelRuns')}
                     </DropdownMenuItem>
                     <DropdownMenuItem
                        disabled={isProtected}
                        title={isProtected ? t('protectedAgent') : undefined}
                        onSelect={() => actions.onArchive(agent)}
                     >
                        {t('menuArchive')}
                     </DropdownMenuItem>
                  </>
               )}
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}
