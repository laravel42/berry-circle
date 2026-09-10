'use client';

import { Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
   AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import {
   archiveSquad,
   assignIssueToSquad,
   getSquad,
   setSquadMembers,
   updateSquad,
   type Squad,
   type SquadRosterEntry,
} from '@/lib/squads';
import { useSessionStore } from '@/store/session-store';

const reason = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

interface RosterRow extends SquadRosterEntry {
   name: string;
}

export default function SquadDetail() {
   const { orgId, squadId } = useParams<{ orgId: string; squadId: string }>();
   const router = useRouter();
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const [squad, setSquad] = useState<Squad | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [people, setPeople] = useState<User[]>([]);
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [leader, setLeader] = useState('');
   const [roster, setRoster] = useState<RosterRow[]>([]);
   const [candidate, setCandidate] = useState('');
   const [issueRef, setIssueRef] = useState('');
   const [busy, setBusy] = useState(false);

   const load = (next: Squad) => {
      setSquad(next);
      setName(next.name);
      setDescription(next.description);
      setLeader(next.leaderAgentId);
      setRoster(next.members.map((member) => ({ ...member })));
   };

   useEffect(() => {
      let cancelled = false;
      getSquad(squadId)
         .then((found) => {
            if (!cancelled) load(found);
         })
         .catch((failure: unknown) => {
            if (!cancelled) setError(reason(failure, 'This squad could not be loaded.'));
         });
      loadWorkspaceAgents().then(
         (found) => {
            if (!cancelled) setAgents(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [squadId]);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      loadWorkspaceMembers(workspaceId).then(
         (found) => {
            if (!cancelled) setPeople(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!squad) return <p className="px-6 py-8 text-muted-foreground">Loading squad…</p>;

   const leaderName = agents.find((agent) => agent.id === squad.leaderAgentId)?.name ?? 'the leader';
   const candidates = [
      ...agents.map((agent) => ({ key: `agent:${agent.id}`, type: 'agent' as const, id: agent.id, name: agent.name })),
      ...people.map((person) => ({ key: `user:${person.id}`, type: 'user' as const, id: person.id, name: person.name })),
   ].filter((entry) => !roster.some((row) => row.type === entry.type && row.id === entry.id));

   const run = async (work: () => Promise<void>) => {
      setBusy(true);
      try {
         await work();
      } finally {
         setBusy(false);
      }
   };

   const saveDetails = () =>
      run(async () => {
         try {
            load(await updateSquad(squad.id, { name: name.trim(), description, leaderAgentId: leader }));
            toast.success('Squad saved');
         } catch (failure) {
            toast.error(reason(failure, 'The squad could not be saved.'));
         }
      });

   const saveRoster = () =>
      run(async () => {
         try {
            load(
               await setSquadMembers(
                  squad.id,
                  roster.map(({ type, id, role }) => ({ type, id, role: role.trim() || 'member' }))
               )
            );
            toast.success('Roster saved');
         } catch (failure) {
            toast.error(reason(failure, 'The roster could not be saved.'));
         }
      });

   const assign = () =>
      run(async () => {
         try {
            const result = await assignIssueToSquad(squad.id, issueRef.trim());
            setIssueRef('');
            toast.success(
               result.runId
                  ? `Assigned to ${leaderName}; its run is queued`
                  : `Assigned to ${leaderName}; it will start when runs are available`
            );
         } catch (failure) {
            toast.error(reason(failure, 'The issue could not be assigned.'));
         }
      });

   const archive = () =>
      run(async () => {
         try {
            await archiveSquad(squad.id);
            toast.success('Squad archived');
            router.push(`/${orgId}/squads`);
         } catch (failure) {
            toast.error(reason(failure, 'The squad could not be archived.'));
         }
      });

   return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
         <section className="flex flex-col gap-3">
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
                  <SelectTrigger className="w-72" aria-label="Leader">
                     <SelectValue />
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
            <Button size="sm" className="w-fit" disabled={busy || !name.trim()} onClick={() => void saveDetails()}>
               Save
            </Button>
         </section>

         <section className="flex flex-col gap-3 border-t border-border/70 pt-4">
            <div>
               <h3 className="font-medium">Roster</h3>
               <p className="text-muted-foreground">
                  The leader delegates to agent members. People are listed so the leader can mention them.
               </p>
            </div>
            {roster.length === 0 ? (
               <p className="text-muted-foreground">No members yet.</p>
            ) : (
               <ul className="flex flex-col rounded-md border border-border">
                  {roster.map((row, index) => (
                     <li
                        key={`${row.type}:${row.id}`}
                        className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                     >
                        <span className="min-w-0 flex-1 truncate">
                           {row.name}{' '}
                           <span className="text-muted-foreground">({row.type === 'agent' ? 'agent' : 'person'})</span>
                        </span>
                        <Input
                           className="h-7 w-40"
                           value={row.role}
                           aria-label={`Role of ${row.name}`}
                           onChange={(event) =>
                              setRoster(roster.map((entry, at) => (at === index ? { ...entry, role: event.target.value } : entry)))
                           }
                        />
                        <Button
                           size="xs"
                           variant="ghost"
                           aria-label={`Remove ${row.name}`}
                           onClick={() => setRoster(roster.filter((_, at) => at !== index))}
                        >
                           <Trash2 className="size-4" />
                        </Button>
                     </li>
                  ))}
               </ul>
            )}
            <div className="flex items-center gap-2">
               <Select value={candidate} onValueChange={setCandidate}>
                  <SelectTrigger className="w-72" aria-label="Add member">
                     <SelectValue placeholder="Add an agent or person" />
                  </SelectTrigger>
                  <SelectContent>
                     {candidates.map((entry) => (
                        <SelectItem key={entry.key} value={entry.key}>
                           {entry.name} · {entry.type === 'agent' ? 'agent' : 'person'}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Button
                  size="xs"
                  variant="secondary"
                  disabled={!candidate}
                  onClick={() => {
                     const entry = candidates.find((option) => option.key === candidate);
                     if (!entry) return;
                     setRoster([...roster, { type: entry.type, id: entry.id, name: entry.name, role: 'member' }]);
                     setCandidate('');
                  }}
               >
                  Add
               </Button>
               <Button size="xs" disabled={busy} onClick={() => void saveRoster()}>
                  Save roster
               </Button>
            </div>
         </section>

         <section className="flex flex-col gap-3 border-t border-border/70 pt-4">
            <div>
               <h3 className="font-medium">Assign an issue</h3>
               <p className="text-muted-foreground">The issue goes to {leaderName}, who splits it among the squad.</p>
            </div>
            <div className="flex items-center gap-2">
               <Input
                  className="w-60"
                  value={issueRef}
                  placeholder="Issue key or id"
                  aria-label="Issue key or id"
                  onChange={(event) => setIssueRef(event.target.value)}
               />
               <Button size="xs" disabled={busy || !issueRef.trim()} onClick={() => void assign()}>
                  Assign
               </Button>
            </div>
         </section>

         <section className="flex flex-col gap-2 border-t border-border/70 pt-4">
            <AlertDialog>
               <AlertDialogTrigger asChild>
                  <Button size="xs" variant="secondary" className="w-fit" disabled={busy}>
                     Archive squad
                  </Button>
               </AlertDialogTrigger>
               <AlertDialogContent>
                  <AlertDialogHeader>
                     <AlertDialogTitle>Archive {squad.name}?</AlertDialogTitle>
                     <AlertDialogDescription>
                        The squad stops receiving issues. Its members and their work are kept.
                     </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                     <AlertDialogCancel>Cancel</AlertDialogCancel>
                     <AlertDialogAction onClick={() => void archive()}>Archive</AlertDialogAction>
                  </AlertDialogFooter>
               </AlertDialogContent>
            </AlertDialog>
         </section>
      </div>
   );
}
