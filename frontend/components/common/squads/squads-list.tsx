'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { createSquad, listSquads, type Squad } from '@/lib/squads';

interface SquadsListProps {
   creating: boolean;
   onCreatingChange: (open: boolean) => void;
}

export default function SquadsList({ creating, onCreatingChange }: SquadsListProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const [squads, setSquads] = useState<Squad[] | null>(null);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [leader, setLeader] = useState('');
   const [busy, setBusy] = useState(false);

   useEffect(() => {
      let cancelled = false;
      Promise.all([listSquads(), loadWorkspaceAgents()])
         .then(([foundSquads, foundAgents]) => {
            if (cancelled) return;
            setSquads(foundSquads);
            setAgents(foundAgents);
         })
         .catch((failure: unknown) => {
            if (!cancelled) {
               setError(failure instanceof BerryApiError ? failure.message : 'Squads could not be loaded.');
            }
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'An archived agent';

   const create = async () => {
      setBusy(true);
      try {
         const squad = await createSquad({ name: name.trim(), description, leaderAgentId: leader });
         setSquads((current) => [...(current ?? []), squad].sort((a, b) => a.name.localeCompare(b.name)));
         setName('');
         setDescription('');
         setLeader('');
         onCreatingChange(false);
         toast.success(`Created ${squad.name}`);
      } catch (failure) {
         toast.error(failure instanceof BerryApiError ? failure.message : 'The squad could not be created.');
      } finally {
         setBusy(false);
      }
   };

   return (
      <div className="w-full">
         {error ? (
            <p className="px-6 py-8 text-muted-foreground">{error}</p>
         ) : squads === null ? (
            <p className="px-6 py-8 text-muted-foreground">Loading squads…</p>
         ) : squads.length === 0 ? (
            <p className="px-6 py-8 text-muted-foreground">
               No squads yet. A squad puts agents and people under one leader agent, who splits the work.
            </p>
         ) : (
            <>
               <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
                  <div className="min-w-0 flex-1">Squad</div>
                  <div className="hidden w-45 shrink-0 md:block">Leader</div>
                  <div className="w-20 shrink-0 text-right">Members</div>
               </div>
               {squads.map((squad) => (
                  <Link
                     key={squad.id}
                     href={`/${orgId}/squads/${squad.id}`}
                     className="flex w-full items-center border-b border-muted-foreground/5 px-6 py-3 last:border-b-0 hover:bg-sidebar/50"
                  >
                     <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{squad.name}</p>
                        {squad.description ? (
                           <p className="line-clamp-1 text-muted-foreground">{squad.description}</p>
                        ) : null}
                     </div>
                     <div className="hidden w-45 shrink-0 truncate text-muted-foreground md:block">
                        {agentName(squad.leaderAgentId)}
                     </div>
                     <div className="w-20 shrink-0 text-right text-muted-foreground">{squad.members.length}</div>
                  </Link>
               ))}
            </>
         )}

         <Dialog open={creating} onOpenChange={onCreatingChange}>
            <DialogContent className="sm:max-w-lg">
               <DialogHeader>
                  <DialogTitle>New squad</DialogTitle>
               </DialogHeader>
               <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">Name</span>
                     <Input value={name} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">Description</span>
                     <Input value={description} onChange={(event) => setDescription(event.target.value)} />
                  </label>
                  <div className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">Leader</span>
                     <Select value={leader} onValueChange={setLeader}>
                        <SelectTrigger aria-label="Leader">
                           <SelectValue placeholder="Choose the agent that leads" />
                        </SelectTrigger>
                        <SelectContent>
                           {agents.map((agent) => (
                              <SelectItem key={agent.id} value={agent.id}>
                                 {agent.name}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>
                  <Button
                     size="sm"
                     className="w-fit"
                     disabled={busy || !name.trim() || !leader}
                     onClick={() => void create()}
                  >
                     Create squad
                  </Button>
               </div>
            </DialogContent>
         </Dialog>
      </div>
   );
}
