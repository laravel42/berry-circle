'use client';

import {
   DeleteProjectDialog,
   useProjectDeletion,
} from '@/components/common/projects/delete-project';
import { CapacityRing } from '@/components/common/cycles/capacity-ring';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import { ProjectDetail } from '@/data/project-details';
import { Project } from '@/data/projects';
import { PanelFilterTarget, usePanelFilter } from '@/components/common/issues/use-panel-filter';
import { RepositorySelector } from '@/components/common/projects/repository-selector';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
import { cn } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { ProjectProgressChart } from './project-progress-chart';
import {
   ArrowRight,
   Calendar,
   Check,
   Link as LinkIcon,
   Plus,
   Tag,
   Trash2,
   UserPlus,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { PinToggle } from '@/components/common/issues/details/issue-pin-button';
import { WORKSPACE_SLUG } from '@/lib/config';
import { ProjectDetailLeadPicker } from '../project-detail-lead-picker';
import { ProjectDetailStatusSelector } from '../project-detail-status-selector';
import { PrioritySelector } from '../priority-selector';

interface ProjectPropertiesPanelProps {
   project: Project;
   detail: ProjectDetail;
   issues: Issue[];
   compact?: boolean;
   onDeleted?: () => void;
}

const isCompleted = (issue: Issue) => issue.status.category === 'completed';

const formatDay = (iso?: string) => (iso ? format(parseISO(iso), 'MMM do') : '—');

interface BreakdownRow {
   key: string;
   label: string;
   leading: React.ReactNode;
   total: number;
   completedPercent: number;
   /** Click-to-filter target (exclusive, like the insights panel rows). */
   target?: PanelFilterTarget;
}

function buildRows<T>(
   issues: Issue[],
   keyOf: (issue: Issue) => T | undefined,
   describe: (key: T, sample: Issue) => Omit<BreakdownRow, 'total' | 'completedPercent'>
): BreakdownRow[] {
   const buckets = new Map<T, Issue[]>();
   for (const issue of issues) {
      const key = keyOf(issue);
      if (key === undefined) continue;
      buckets.set(key, [...(buckets.get(key) ?? []), issue]);
   }
   return [...buckets.entries()]
      .map(([key, bucket]) => ({
         ...describe(key, bucket[0]),
         total: bucket.length,
         completedPercent: Math.round((bucket.filter(isCompleted).length / bucket.length) * 100),
      }))
      .sort((a, b) => b.total - a.total);
}

function BreakdownList({
   rows,
   panelFilter,
}: {
   rows: BreakdownRow[];
   panelFilter: ReturnType<typeof usePanelFilter>;
}) {
   if (rows.length === 0) {
      return <p className="text-muted-foreground px-1 py-3">Nothing to show yet.</p>;
   }
   return (
      <div className="flex flex-col">
         {rows.map((row) => {
            const active = row.target ? panelFilter.isActive(row.target) : false;
            return (
               <button
                  key={row.key}
                  type="button"
                  onClick={() => row.target && panelFilter.toggle(row.target)}
                  className={cn(
                     'flex items-center justify-between gap-3 py-2 px-1.5 -mx-1.5 rounded-md text-left transition-colors',
                     row.target && 'cursor-pointer hover:bg-accent/50',
                     active && 'bg-accent hover:bg-accent'
                  )}
               >
                  <div className="flex items-center gap-2 min-w-0">
                     {row.leading}
                     <span className="truncate">{row.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
                     <CapacityRing value={row.completedPercent} color="#6771c5" />
                     <span className="whitespace-nowrap">
                        {row.completedPercent}% of {row.total}
                     </span>
                  </div>
               </button>
            );
         })}
      </div>
   );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <div className="flex items-center justify-between gap-4 min-h-7">
         <span className="text-muted-foreground shrink-0">{label}</span>
         <div className="flex items-center gap-1.5 min-w-0">{children}</div>
      </div>
   );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
   return (
      <div>
         <div className="mb-2 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {title.toLowerCase()}
         </div>
         {children}
      </div>
   );
}

function ProjectPropertiesPanelCompact({
   project,
   detail,
   onDeleted,
}: {
   project: Project;
   detail: ProjectDetail;
   onDeleted?: () => void;
}) {
   const members = useMembersStore((state) => state.members);
   const { updateProjectStatus, updateProjectPriority, updateProjectLead } = useProjectsStore();
   const deletion = useProjectDeletion(onDeleted);
   const { orgId } = useParams<{ orgId?: string }>();

   return (
      <>
         <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto">
               <SidebarSection title="Properties">
                  <div className="flex flex-col gap-1.5">
                     <div className="flex items-center gap-1.5 -ml-1.5">
                        <ProjectDetailStatusSelector
                           status={project.status}
                           onStatusChange={(status) => updateProjectStatus(project.id, status)}
                        />
                        <span>{project.status.name}</span>
                     </div>
                     <div className="flex items-center gap-1.5 -ml-1.5">
                        <PrioritySelector
                           priority={project.priority}
                           onPriorityChange={(priorityId) => {
                              const match = priorities.find((entry) => entry.id === priorityId);
                              if (match) updateProjectPriority(project.id, match);
                           }}
                        />
                        <span>{project.priority.name}</span>
                     </div>
                     <div className="flex items-center gap-1.5 -ml-1.5 mt-0.5">
                        <ProjectDetailLeadPicker
                           lead={project.lead}
                           members={members}
                           onLeadChange={(member) => updateProjectLead(project.id, member)}
                        />
                        <span className="truncate">{project.lead.name}</span>
                     </div>
                     {(project.startDate || project.targetDate) && (
                        <div className="flex items-center gap-1.5 -ml-1.5">
                           <span className="flex size-7 shrink-0 items-center justify-center">
                              <Calendar className="size-4" />
                           </span>
                           <span className="truncate">
                              {formatDay(project.startDate)}
                              {project.targetDate ? ` – ${formatDay(project.targetDate)}` : ''}
                           </span>
                        </div>
                     )}
                  </div>
               </SidebarSection>

               {detail.milestones.length > 0 && (
                  <SidebarSection title="Milestones">
                     {detail.milestones.map((milestone, index) => (
                        <div
                           key={milestone.id}
                           className={
                              index === 0
                                 ? 'flex items-center gap-2 min-w-0'
                                 : 'mt-1.5 flex items-center gap-2 pl-6 text-muted-foreground min-w-0'
                           }
                        >
                           <span className="size-2 shrink-0 rotate-45 border border-status-warning" />
                           <span className="truncate">{milestone.name}</span>
                        </div>
                     ))}
                  </SidebarSection>
               )}
            </div>

            {/* The three things done to a project from its own page: put it in
                the rail, hand someone the link, or remove it. */}
            <div className="flex shrink-0 items-center justify-end">
               <PinToggle targetType="project" targetId={project.id} />
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Copy link"
                  title="Copy link"
                  onClick={() => {
                     void navigator.clipboard.writeText(
                        `${window.location.origin}/${orgId ?? WORKSPACE_SLUG}/project/${project.id}/overview`
                     );
                     toast.success('Link copied to clipboard');
                  }}
               >
                  <LinkIcon className="size-4" />
               </Button>
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 translate-x-[10px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete project"
                  onClick={() => deletion.request(project)}
               >
                  <Trash2 className="size-4" />
               </Button>
            </div>
         </div>

         <DeleteProjectDialog deletion={deletion} />
      </>
   );
}

/**
 * Right-side panel of the project pages: properties, milestones,
 * progress breakdowns and a compact activity feed.
 */
export function ProjectPropertiesPanel({
   project,
   detail,
   issues,
   compact = false,
   onDeleted,
}: ProjectPropertiesPanelProps) {
   const panelFilter = usePanelFilter();
   const completed = issues.filter(isCompleted).length;

   const started = issues.filter((issue) => issue.status.category === 'started').length;

   const members = useMemo(() => {
      const seen = new Set<string>();
      return issues
         .map((issue) => issue.assignee)
         .filter((assignee): assignee is NonNullable<typeof assignee> => {
            if (!assignee || seen.has(assignee.id)) return false;
            seen.add(assignee.id);
            return true;
         });
   }, [issues]);

   const assigneeRows = useMemo(
      () =>
         buildRows(
            issues,
            (issue) => issue.assignee?.id ?? 'no-assignee',
            (key, sample) =>
               sample.assignee
                  ? {
                       key: String(key),
                       label: sample.assignee.name,
                       leading: (
                          <Avatar className="size-5 shrink-0">
                             <AvatarImage
                                src={sample.assignee.avatarUrl}
                                alt={sample.assignee.name}
                             />
                             <AvatarFallback>{sample.assignee.name[0]}</AvatarFallback>
                          </Avatar>
                       ),
                       target: { columnId: 'assignee', value: sample.assignee.id },
                    }
                  : {
                       key: 'no-assignee',
                       label: 'No assignee',
                       leading: null,
                       target: { columnId: 'assignee', value: 'unassigned' },
                    }
         ),
      [issues]
   );

   const labelRows = useMemo(
      () =>
         buildRows(
            issues,
            (issue) => issue.labels[0]?.id,
            (key, sample) => ({
               key: String(key),
               label: sample.labels[0]?.name ?? 'Unlabeled',
               leading: (
                  <span
                     className="size-2.5 rounded-full shrink-0"
                     style={{ backgroundColor: sample.labels[0]?.color ?? 'gray' }}
                  />
               ),
               target: { columnId: 'labels', value: String(key) },
            })
         ),
      [issues]
   );

   if (compact) {
      return (
         <ProjectPropertiesPanelCompact project={project} detail={detail} onDeleted={onDeleted} />
      );
   }

   return (
      <div className="flex flex-col h-full w-full overflow-y-auto">
         {/* Properties */}
         <div className="px-5 pt-4 pb-4 border-b">
            <h3 className="font-medium mb-2.5">Properties</h3>
            <div className="flex flex-col gap-1">
               <PropertyRow label="Status">
                  <project.status.icon />
                  <span>{project.status.name}</span>
               </PropertyRow>
               <PropertyRow label="Priority">
                  <project.priority.icon className="size-3.5 text-muted-foreground" />
                  <span>{project.priority.name}</span>
               </PropertyRow>
               <PropertyRow label="Repository">
                  <RepositorySelector project={project} />
               </PropertyRow>
               <PropertyRow label="Lead">
                  <Avatar className="size-5">
                     <AvatarImage src={project.lead.avatarUrl} alt={project.lead.name} />
                     <AvatarFallback>{project.lead.name[0]}</AvatarFallback>
                  </Avatar>
                  <span className="truncate max-w-36">{project.lead.name}</span>
               </PropertyRow>
               <PropertyRow label="Members">
                  {members.length > 0 ? (
                     <span className="inline-flex items-center gap-1.5">
                        <span className="flex -space-x-1.5">
                           {members.slice(0, 3).map((member) => (
                              <Avatar key={member.id} className="size-5 border-2 border-container">
                                 <AvatarImage src={member.avatarUrl} alt={member.name} />
                                 <AvatarFallback>{member.name[0]}</AvatarFallback>
                              </Avatar>
                           ))}
                        </span>
                        {members.length} {members.length === 1 ? 'member' : 'members'}
                     </span>
                  ) : (
                     <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors">
                        <UserPlus className="size-3.5" />
                        Add members
                     </button>
                  )}
               </PropertyRow>
               <PropertyRow label="Dates">
                  <span className="inline-flex items-center gap-1">
                     <Calendar className="size-3.5 text-muted-foreground" />
                     {formatDay(project.startDate)}
                  </span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="inline-flex items-center gap-1">
                     <Calendar className="size-3.5 text-muted-foreground" />
                     {project.targetDate ? formatDay(project.targetDate) : 'Target'}
                  </span>
               </PropertyRow>
               <PropertyRow label="Labels">
                  <div className="flex items-center gap-1.5">
                     {project.labels.length === 0 && (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                           <Tag className="size-3.5" />
                           Add label
                        </span>
                     )}
                     {project.labels.map((label) => (
                        <span
                           key={label.id}
                           className="inline-flex items-center gap-1 border rounded-full px-2 py-0.5"
                        >
                           <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: label.color }}
                           />
                           {label.name}
                        </span>
                     ))}
                     <button className="text-muted-foreground hover:text-foreground transition-colors">
                        <Plus className="size-3.5" />
                     </button>
                  </div>
               </PropertyRow>
            </div>
         </div>

         {/* Milestones */}
         <div className="px-5 py-4 border-b">
            <div className="flex items-center justify-between mb-2">
               <h3 className="font-medium">Milestones</h3>
               <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <Plus className="size-3.5" />
               </button>
            </div>
            {detail.milestones.length === 0 ? (
               <p className="text-muted-foreground">
                  Add milestones to organize work within your project and break it into more
                  granular stages. <span className="text-foreground/70 underline">Learn more</span>
               </p>
            ) : (
               <div className="flex flex-col gap-1.5">
                  {detail.milestones.map((milestone) => (
                     <div key={milestone.id} className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 min-w-0">
                           <span
                              className={
                                 milestone.completed
                                    ? 'size-4 rounded-full bg-violet-500 flex items-center justify-center shrink-0'
                                    : 'size-4 rounded-full border border-muted-foreground/40 shrink-0'
                              }
                           >
                              {milestone.completed && <Check className="size-2.5 text-white" />}
                           </span>
                           <span
                              className={
                                 milestone.completed
                                    ? 'truncate line-through text-muted-foreground'
                                    : 'truncate'
                              }
                           >
                              {milestone.name}
                           </span>
                        </span>
                        <span className="text-muted-foreground whitespace-nowrap">
                           {formatDay(milestone.targetDate)}
                        </span>
                     </div>
                  ))}
               </div>
            )}
         </div>

         {/* Progress */}
         <div className="px-5 py-4 border-b">
            <h3 className="font-medium mb-3">Progress</h3>
            <div className="grid grid-cols-3 gap-2 mb-2">
               <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                     <span className="size-2 rounded-[2px] bg-[#8f9299]" />
                     Scope
                  </div>
                  <span className="font-medium">{issues.length}</span>
               </div>
               <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                     <span className="size-2 rounded-[2px] bg-[#facc15]" />
                     Started
                  </div>
                  <span className="font-medium">{started}</span>
               </div>
               <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                     <span className="size-2 rounded-[2px] bg-[#6771c5]" />
                     Completed
                  </div>
                  <span className="font-medium">{completed}</span>
               </div>
            </div>
            <div className="mb-3">
               <ProjectProgressChart
                  startDate={project.startDate}
                  endDate={project.targetDate ?? project.startDate}
                  scope={issues.length}
                  started={started}
                  completed={completed}
               />
            </div>
            <Tabs defaultValue="assignees">
               <TabsList className="h-8 bg-transparent gap-1 p-0">
                  <TabsTrigger value="assignees" className="px-2.5 rounded-full">
                     Assignees
                  </TabsTrigger>
                  <TabsTrigger value="labels" className="px-2.5 rounded-full">
                     Labels
                  </TabsTrigger>
               </TabsList>
               <TabsContent value="assignees">
                  <BreakdownList rows={assigneeRows} panelFilter={panelFilter} />
               </TabsContent>
               <TabsContent value="labels">
                  <BreakdownList rows={labelRows} panelFilter={panelFilter} />
               </TabsContent>
            </Tabs>
         </div>

         {/* Activity */}
         <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-2">
               <h3 className="font-medium">Activity</h3>
               <button className="text-muted-foreground hover:text-foreground transition-colors">
                  See all
               </button>
            </div>
            <div className="flex flex-col gap-3">
               {detail.activity.map((event) => (
                  <div key={event.id} className="flex items-start gap-2">
                     <Avatar className="size-4 mt-0.5 shrink-0">
                        <AvatarImage src={event.user.avatarUrl} alt={event.user.name} />
                        <AvatarFallback>{event.user.name[0]}</AvatarFallback>
                     </Avatar>
                     <p className="text-muted-foreground leading-relaxed">
                        <span className="text-foreground">{event.user.name}</span> {event.text} ·{' '}
                        {formatDay(event.date)}
                     </p>
                  </div>
               ))}
            </div>
         </div>
      </div>
   );
}
