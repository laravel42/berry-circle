'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { CrewLeaderSelector } from '@/components/common/teams/create-crew/leader-selector';
import { CrewMembersSelector } from '@/components/common/teams/create-crew/members-selector';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { User } from '@/data/users';
import type { Agent } from '@/lib/agents';
import { agentToUser } from '@/lib/agents';
import { BerryApiError } from '@/lib/api';
import { WORKSPACE_NAME } from '@/lib/config';
import { useAgentsStore } from '@/store/agents-store';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
import { createWorkspaceCrew, useTeamsStore } from '@/store/teams-store';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

interface CreateCrewDialogProps {
   open: boolean;
   onOpenChange: (open: boolean) => void;
}

/** Compose dialog for creating a crew — matches the create-project chrome. */
export function CreateCrewDialog({ open, onOpenChange }: CreateCrewDialogProps) {
   const addTeam = useTeamsStore((state) => state.addTeam);
   const members = useMembersStore((state) => state.members);
   const projects = useProjectsStore((state) => state.projects);
   const agents = useAgentsStore((state) => state.agents);
   const [pending, setPending] = useState(false);
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [leader, setLeader] = useState<Agent | undefined>();
   const [additionalMembers, setAdditionalMembers] = useState<User[]>([]);

   useEffect(() => {
      if (!open) return;
      setName('');
      setDescription('');
      setLeader(undefined);
      setAdditionalMembers([]);
      setPending(false);
   }, [open]);

   const memberCandidates = useMemo(() => {
      const people = [...members, ...agents.map(agentToUser)].filter(
         (person, index, list) => list.findIndex((entry) => entry.id === person.id) === index
      );
      return people.filter((person) => person.id !== leader?.id);
   }, [agents, leader?.id, members]);

   const createCrew = async () => {
      const trimmed = name.trim();
      if (!trimmed) {
         toast.error('Crew name is required');
         return;
      }
      if (!leader) {
         toast.error('Choose a leader agent');
         return;
      }
      setPending(true);
      try {
         const crew = await createWorkspaceCrew({
            name: trimmed,
            description: description.trim() || undefined,
            lead: agentToUser(leader),
            members: additionalMembers,
            projects,
         });
         addTeam(crew);
         toast.success('Crew created');
         onOpenChange(false);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not create crew');
      } finally {
         setPending(false);
      }
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent
            showCloseButton={false}
            className="flex w-full h-[min(42rem,calc(100vh-3.5rem))] flex-col gap-0 p-0 shadow-lg top-[5vh] translate-y-0 sm:max-w-[40rem]"
         >
            <DialogHeader className="px-6 pt-5 pb-0">
               <DialogTitle className="sr-only">New crew</DialogTitle>
               <DialogDescription className="sr-only">
                  Name the crew, describe it, choose a leader agent, and optionally add members.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     <span className="truncate">New crew</span>
                  </div>
                  <Button
                     type="button"
                     variant="ghost"
                     size="icon"
                     className="size-8 shrink-0"
                     aria-label="Close"
                     onClick={() => onOpenChange(false)}
                  >
                     <X className="size-4" />
                  </Button>
               </div>
            </DialogHeader>

            <form
               className="flex min-h-0 flex-1 flex-col"
               onSubmit={(event) => {
                  event.preventDefault();
                  void createCrew();
               }}
            >
               <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-4">
                  <label htmlFor="create-crew-name" className="sr-only">
                     Crew name
                  </label>
                  <Input
                     id="create-crew-name"
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 text-2xl font-medium text-foreground shadow-none placeholder:text-foreground/40 md:text-2xl"
                     placeholder="Crew name"
                     value={name}
                     onChange={(event) => setName(event.target.value)}
                  />

                  <label htmlFor="create-crew-description" className="sr-only">
                     Description
                  </label>
                  <MarkdownTextarea
                     id="create-crew-description"
                     className="mt-0.5 min-h-16 resize-none border-none bg-transparent px-0 pt-1 text-base text-foreground shadow-none [-webkit-text-fill-color:var(--foreground)] placeholder:text-foreground/40 placeholder:[-webkit-text-fill-color:color-mix(in_oklab,var(--foreground)_40%,transparent)] md:text-base"
                     placeholder="Write a description…"
                     value={description}
                     onChange={setDescription}
                  />

                  <div className="mt-4">
                     <div>
                        <p className="text-sm leading-none text-foreground">Leader agent</p>
                        <p className="mt-px mb-3 text-xs leading-snug text-foreground/40">
                           The leader receives all tasks assigned to this squad and coordinates the
                           team.
                        </p>
                        <div>
                           <CrewLeaderSelector
                              leader={leader}
                              onChange={(next) => {
                                 setLeader(next);
                                 setAdditionalMembers((current) =>
                                    current.filter((member) => member.id !== next.id)
                                 );
                              }}
                           />
                        </div>
                     </div>
                     <div>
                        <p className="mt-6 text-sm leading-none text-foreground">Additional members</p>
                        <p className="mt-px mb-3 text-xs leading-snug text-foreground/40">
                           Members the leader can delegate sub-tasks to. Can be added later.
                        </p>
                        <div>
                           <CrewMembersSelector
                              candidates={memberCandidates}
                              selected={additionalMembers}
                              onChange={setAdditionalMembers}
                           />
                        </div>
                     </div>
                  </div>
               </div>

               <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-3">
                  <Button
                     type="button"
                     variant="ghost"
                     size="sm"
                     onClick={() => onOpenChange(false)}
                  >
                     Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={pending || !name.trim() || !leader}>
                     {pending ? 'Creating…' : 'Create crew'}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
