'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { statusUserColors, User } from '@/data/users';
import { agentToUser } from '@/lib/agents';
import { useAgentsStore } from '@/store/agents-store';
import { useMembersStore } from '@/store/members-store';
import { useIssuesStore } from '@/store/issues-store';
import { CheckIcon, Send, UserIcon, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const MAX_VISIBLE_AGENTS = 10;

interface AssigneeUserProps {
   user: User | null;
   issueId?: string;
   /** Kanban cards: show the dashed user placeholder for agent assignees too. */
   placeholderForAgents?: boolean;
}

function AssigneePlaceholder() {
   return (
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/45 bg-muted/20">
         <UserRound className="size-3.5 text-muted-foreground/70" />
      </div>
   );
}

function AssigneeMenuItem({
   person,
   selected,
   onSelect,
}: {
   person: User;
   selected: boolean;
   onSelect: () => void;
}) {
   return (
      <DropdownMenuItem
         onClick={(event) => {
            event.stopPropagation();
            onSelect();
         }}
      >
         <div className="flex items-center gap-2">
            {person.role === 'Application' ? (
               <BerryMark size="sm" tone="working" label={`${person.name}, agent`} />
            ) : (
               <Avatar className="h-5 w-5">
                  <AvatarImage src={person.avatarUrl} alt={person.name} />
                  <AvatarFallback>{person.name[0]}</AvatarFallback>
               </Avatar>
            )}
            <span>{person.name}</span>
         </div>
         {selected ? <CheckIcon className="ml-auto h-4 w-4" /> : null}
      </DropdownMenuItem>
   );
}

export function AssigneeUser({ user, issueId, placeholderForAgents = false }: AssigneeUserProps) {
   const [open, setOpen] = useState(false);
   const [agentQuery, setAgentQuery] = useState('');
   const [currentAssignee, setCurrentAssignee] = useState<User | null>(user);
   const agents = useAgentsStore((state) => state.agents);
   const members = useMembersStore((state) => state.members);
   const updateIssueAssignee = useIssuesStore((state) => state.updateIssueAssignee);

   const agentAssignees = useMemo(() => agents.map(agentToUser), [agents]);

   const visibleAgents = useMemo(() => {
      const query = agentQuery.trim().toLowerCase();
      let matches = query
         ? agentAssignees.filter((agent) => agent.name.toLowerCase().includes(query))
         : [...agentAssignees];

      if (currentAssignee?.role === 'Application') {
         matches = [
            currentAssignee,
            ...matches.filter((agent) => agent.id !== currentAssignee.id),
         ];
      }

      return matches.slice(0, MAX_VISIBLE_AGENTS);
   }, [agentAssignees, agentQuery, currentAssignee]);

   useEffect(() => {
      setCurrentAssignee(user);
   }, [user]);

   useEffect(() => {
      if (!open) {
         setAgentQuery('');
      }
   }, [open]);

   const handleAssigneeChange = (assignee: User | null) => {
      setCurrentAssignee(assignee);
      setOpen(false);
      if (issueId) {
         updateIssueAssignee(issueId, assignee);
      }
   };

   const renderAvatar = () => {
      if (!currentAssignee) {
         return <AssigneePlaceholder />;
      }

      if (currentAssignee.role === 'Application') {
         if (placeholderForAgents) {
            return <AssigneePlaceholder />;
         }

         return (
            <span className="flex size-6 shrink-0 items-center justify-center">
               <BerryMark size="sm" tone="working" label={`${currentAssignee.name}, agent`} />
            </span>
         );
      }

      return (
         <Avatar className="size-6 shrink-0">
            <AvatarImage src={currentAssignee.avatarUrl} alt={currentAssignee.name} />
            <AvatarFallback>{currentAssignee.name[0]}</AvatarFallback>
         </Avatar>
      );
   };

   return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
         <DropdownMenuTrigger asChild>
            <button
               className="relative w-fit rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
               aria-label={currentAssignee ? `Assigned to ${currentAssignee.name}` : 'Assign task'}
            >
               {renderAvatar()}
               {currentAssignee && currentAssignee.role !== 'Application' ? (
                  <span
                     className="border-background absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2"
                     style={{ backgroundColor: statusUserColors[currentAssignee.status] }}
                  >
                     <span className="sr-only">{currentAssignee.status}</span>
                  </span>
               ) : null}
            </button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-[220px]">
            <DropdownMenuLabel>assign to…</DropdownMenuLabel>
            <DropdownMenuItem
               onClick={(event) => {
                  event.stopPropagation();
                  handleAssigneeChange(null);
               }}
            >
               <div className="flex items-center gap-2">
                  <UserIcon className="h-5 w-5" />
                  <span>no assignee</span>
               </div>
               {!currentAssignee ? <CheckIcon className="ml-auto h-4 w-4" /> : null}
            </DropdownMenuItem>

            {members.length > 0 ? (
               <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>members</DropdownMenuLabel>
                  {members.map((member) => (
                     <AssigneeMenuItem
                        key={member.id}
                        person={member}
                        selected={currentAssignee?.id === member.id}
                        onSelect={() => handleAssigneeChange(member)}
                     />
                  ))}
               </>
            ) : null}

            {agentAssignees.length > 0 ? (
               <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>agents</DropdownMenuLabel>
                  <div
                     className="px-2 pb-1"
                     onKeyDown={(event) => event.stopPropagation()}
                     onPointerDown={(event) => event.stopPropagation()}
                  >
                     <Input
                        value={agentQuery}
                        onChange={(event) => setAgentQuery(event.target.value)}
                        placeholder="Filter agents…"
                        className="h-8"
                        aria-label="Filter agents"
                     />
                  </div>
                  {visibleAgents.length > 0 ? (
                     visibleAgents.map((agent) => (
                        <AssigneeMenuItem
                           key={agent.id}
                           person={agent}
                           selected={currentAssignee?.id === agent.id}
                           onSelect={() => handleAssigneeChange(agent)}
                        />
                     ))
                  ) : (
                     <div className="px-2 py-1.5 text-muted-foreground">No agents found</div>
                  )}
                  {agentAssignees.length > MAX_VISIBLE_AGENTS && !agentQuery.trim() ? (
                     <div className="px-2 py-1 text-muted-foreground">
                        Showing {MAX_VISIBLE_AGENTS} of {agentAssignees.length}. Type to filter.
                     </div>
                  ) : null}
               </>
            ) : null}

            <DropdownMenuSeparator />
            <DropdownMenuLabel>new user</DropdownMenuLabel>
            <DropdownMenuItem>
               <div className="flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  <span>invite and assign…</span>
               </div>
            </DropdownMenuItem>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
