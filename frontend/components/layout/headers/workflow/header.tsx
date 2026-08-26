'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { useWorkflowActions } from '@/components/common/workflows/use-workflow-actions';
import { WorkflowStatusBadge } from '@/components/common/workflows/workflow-status-badge';
import { WorkflowWebhookDialog } from '@/components/common/workflows/workflow-webhook-dialog';
import { useDetailDrawerClose } from '@/components/layout/detail-drawer-context';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WORKFLOW_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import { activationBlocker, canRunWorkflow } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useMembersStore } from '@/store/members-store';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { ChevronRight, MoreHorizontal, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

const TABS = [
   { segment: 'overview', label: 'Overview' },
   { segment: 'history', label: 'History' },
   { segment: 'canvas', label: 'Canvas' },
] as const;

/**
 * Workflow header: crumb (automations › mark + name), status, Activate or
 * Pause, the actions menu (Run now, webhook secret, Archive) and the pill
 * tabs. The verbs report in words; the disabled Activate says why.
 */
export default function Header({ workflowId }: { workflowId: string }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const pathname = usePathname() ?? '';
   const router = useRouter();
   const closeDrawer = useDetailDrawerClose();
   const workflow = useWorkflowsStore((state) =>
      state.workflows.find((candidate) => candidate.id === workflowId)
   );
   const userId = useSessionStore((state) => state.user?.id);
   const isAdmin = useMembersStore((state) => {
      const member = userId
         ? state.members.find((candidate) => candidate.id === userId)
         : undefined;
      return member ? member.role === 'Admin' : undefined;
   });
   const { busy, activate, pause, runNow, archive } = useWorkflowActions(workflowId);
   const [webhookOpen, setWebhookOpen] = useState(false);
   const [archiveOpen, setArchiveOpen] = useState(false);

   const look = workflow ? statusLook(WORKFLOW_STATUS, workflow.status) : null;
   const blocker = workflow ? activationBlocker(workflow, { isAdmin }) : 'Loading…';
   const active = workflow?.status === 'active';

   const onRunNow = () => {
      void runNow().then((run) => {
         if (run) router.push(`/${orgId}/workflow/${workflowId}/run/${run.id}`);
      });
   };

   const onArchive = () => {
      void archive().then((done) => {
         if (!done) return;
         if (closeDrawer) closeDrawer();
         else router.push(`/${orgId}/workflows`);
      });
   };

   return (
      <div className="flex w-full flex-col border-b">
         <div className="flex h-10 w-full items-center justify-between gap-4 px-6 py-1.5">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
               <Link
                  href={`/${orgId}/workflows`}
                  className="text-muted-foreground transition-colors hover:text-foreground"
               >
                  Automations
               </Link>
               <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
               <BerryMark
                  size="sm"
                  tone={look?.tone ?? 'neutral'}
                  state={look?.state ?? 'hollow'}
                  pulse={look?.pulse}
               />
               <span className="truncate font-medium">{workflow?.name ?? 'Loading workflow…'}</span>
            </nav>
            <div className="flex shrink-0 items-center gap-2">
               {workflow && (
                  <WorkflowStatusBadge status={workflow.status} className="hidden sm:inline-flex" />
               )}
               {active ? (
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={busy !== null}
                     onClick={() => void pause()}
                  >
                     <Pause className="size-3.5" />
                     {busy === 'pausing' ? 'Pausing…' : 'Pause'}
                  </Button>
               ) : (
                  <Button
                     size="xs"
                     disabled={busy !== null || blocker !== null}
                     title={blocker ?? 'Activate: triggers start firing'}
                     onClick={() => void activate()}
                  >
                     <Play className="size-3.5" />
                     {busy === 'activating' ? 'Activating…' : 'Activate'}
                  </Button>
               )}
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label="Workflow actions"
                        disabled={!workflow}
                     >
                        <MoreHorizontal className="size-4" />
                     </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-48">
                     <DropdownMenuItem
                        disabled={!workflow || !canRunWorkflow(workflow) || busy !== null}
                        onClick={onRunNow}
                        title={
                           workflow && !canRunWorkflow(workflow)
                              ? 'Only an active workflow can run'
                              : undefined
                        }
                     >
                        {busy === 'running' ? 'Starting…' : 'Run now'}
                     </DropdownMenuItem>
                     {workflow?.trigger.type === 'webhook' && (
                        <DropdownMenuItem onClick={() => setWebhookOpen(true)}>
                           Rotate webhook secret
                        </DropdownMenuItem>
                     )}
                     <DropdownMenuSeparator />
                     <DropdownMenuItem
                        className="text-status-danger focus:text-status-danger"
                        onClick={() => setArchiveOpen(true)}
                     >
                        Archive
                     </DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
            </div>
         </div>
         <div className="flex h-9 w-full items-center gap-1 px-6">
            {TABS.map((tab) => {
               const href = `/${orgId}/workflow/${workflowId}/${tab.segment}`;
               const on = pathname.endsWith(`/${tab.segment}`);
               return (
                  <Link
                     key={tab.segment}
                     href={href}
                     aria-current={on ? 'page' : undefined}
                     className={cn(
                        'rounded-md px-2.5 py-1 transition-colors',
                        on
                           ? 'bg-accent text-foreground'
                           : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                     )}
                  >
                     {tab.label}
                  </Link>
               );
            })}
         </div>
         <WorkflowWebhookDialog
            workflowId={workflowId}
            open={webhookOpen}
            onOpenChange={setWebhookOpen}
         />
         <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     Archive “{workflow?.name ?? 'this workflow'}”?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                     It stops firing and leaves the list. Its runs and versions stay readable.
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                     className={buttonVariants({ variant: 'destructive' })}
                     onClick={onArchive}
                  >
                     Archive
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
