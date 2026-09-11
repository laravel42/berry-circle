'use client';

import { ChevronRight, Users, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import type { Agent } from '@/lib/agents';
import { createSquad, type Squad, type SquadRosterEntry } from '@/lib/squads';

const DESCRIPTION_LIMIT = 2000;

interface Props {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onCreated: (squad: Squad) => void;
   agents: Agent[];
   people: User[];
}

interface Chosen extends SquadRosterEntry {
   name: string;
}

/**
 * Making a squad: who leads it, what it is for, and who is in it from the
 * start. The roster travels with the create request, so a squad is never made
 * half-formed and then filled in.
 */
export default function SquadCreateDialog({
   open,
   onOpenChange,
   onCreated,
   agents,
   people,
}: Props) {
   const t = useTranslations('areas.squads');
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [avatarUrl, setAvatarUrl] = useState('');
   const [leader, setLeader] = useState('');
   const [members, setMembers] = useState<Chosen[]>([]);
   const [pane, setPane] = useState<'kind' | 'agent' | 'user'>('kind');
   const [picking, setPicking] = useState(false);
   const [busy, setBusy] = useState(false);

   const reset = () => {
      setName('');
      setDescription('');
      setAvatarUrl('');
      setLeader('');
      setMembers([]);
   };

   const taken = (type: 'agent' | 'user', id: string) =>
      members.some((member) => member.type === type && member.id === id);

   const add = (entry: Chosen) => {
      setMembers((current) => [...current, entry]);
      setPicking(false);
      setPane('kind');
   };

   const submit = async () => {
      setBusy(true);
      try {
         const squad = await createSquad({
            name: name.trim(),
            description: description.trim(),
            leaderAgentId: leader,
            ...(avatarUrl.trim() ? { avatarUrl: avatarUrl.trim() } : {}),
            members: members.map(({ type, id, role }) => ({ type, id, role })),
         });
         toast.success(t('create.created', { name: squad.name }));
         reset();
         onCreated(squad);
         onOpenChange(false);
      } catch (failure) {
         toast.error(failure instanceof BerryApiError ? failure.message : t('create.failed'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <Dialog
         open={open}
         onOpenChange={(next) => {
            if (!next) reset();
            onOpenChange(next);
         }}
      >
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <DialogTitle>{t('create.title')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
               <div className="flex items-center gap-3">
                  <Avatar className="size-10 shrink-0">
                     {avatarUrl.trim() ? <AvatarImage src={avatarUrl.trim()} alt="" /> : null}
                     <AvatarFallback>
                        <Users className="size-4" />
                     </AvatarFallback>
                  </Avatar>
                  <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.avatar')}</span>
                     <Input
                        value={avatarUrl}
                        placeholder="https://…"
                        onChange={(event) => setAvatarUrl(event.target.value)}
                     />
                  </label>
               </div>

               <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">{t('create.name')}</span>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
               </label>

               <label className="flex flex-col gap-1.5">
                  <span className="flex items-center justify-between text-muted-foreground">
                     {t('create.description')}
                     <span>
                        {t('create.counter', {
                           count: description.length,
                           max: DESCRIPTION_LIMIT,
                        })}
                     </span>
                  </span>
                  <Textarea
                     rows={3}
                     value={description}
                     maxLength={DESCRIPTION_LIMIT}
                     onChange={(event) => setDescription(event.target.value)}
                  />
               </label>

               <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">{t('create.leader')}</span>
                  <Select value={leader} onValueChange={setLeader}>
                     <SelectTrigger aria-label={t('create.leader')}>
                        <SelectValue placeholder={t('create.chooseLeader')} />
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

               <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">{t('create.members')}</span>
                  {members.length === 0 ? (
                     <p className="text-muted-foreground">{t('create.membersHint')}</p>
                  ) : (
                     <ul className="flex flex-wrap gap-2">
                        {members.map((member) => (
                           <li
                              key={`${member.type}:${member.id}`}
                              className="flex items-center gap-1 rounded border px-2 py-0.5"
                           >
                              {member.name}
                              <span className="text-muted-foreground">
                                 {t(`create.type_${member.type}`)}
                              </span>
                              <button
                                 type="button"
                                 aria-label={t('create.remove', { name: member.name })}
                                 className="cursor-pointer"
                                 onClick={() =>
                                    setMembers((current) =>
                                       current.filter(
                                          (entry) =>
                                             !(entry.type === member.type && entry.id === member.id)
                                       )
                                    )
                                 }
                              >
                                 <X className="size-3" />
                              </button>
                           </li>
                        ))}
                     </ul>
                  )}
                  <Popover
                     open={picking}
                     onOpenChange={(next) => {
                        setPicking(next);
                        if (!next) setPane('kind');
                     }}
                  >
                     <PopoverTrigger asChild>
                        <Button size="xs" variant="secondary" className="w-fit">
                           {t('create.addMember')}
                        </Button>
                     </PopoverTrigger>
                     <PopoverContent className="w-64 p-0" align="start">
                        {pane === 'kind' ? (
                           <Command>
                              <CommandList>
                                 <CommandGroup>
                                    <CommandItem
                                       onSelect={() => setPane('agent')}
                                       className="justify-between"
                                    >
                                       {t('create.addAgents')}
                                       <ChevronRight className="size-4" />
                                    </CommandItem>
                                    <CommandItem
                                       onSelect={() => setPane('user')}
                                       className="justify-between"
                                    >
                                       {t('create.addPeople')}
                                       <ChevronRight className="size-4" />
                                    </CommandItem>
                                 </CommandGroup>
                              </CommandList>
                           </Command>
                        ) : (
                           <Command>
                              <CommandInput
                                 placeholder={
                                    pane === 'agent'
                                       ? t('create.searchAgents')
                                       : t('create.searchPeople')
                                 }
                              />
                              <CommandList>
                                 <CommandEmpty>{t('create.noneFound')}</CommandEmpty>
                                 <CommandGroup>
                                    {(pane === 'agent' ? agents : people)
                                       .filter((entry) => !taken(pane, entry.id))
                                       .map((entry) => (
                                          <CommandItem
                                             key={entry.id}
                                             value={entry.name}
                                             onSelect={() =>
                                                add({
                                                   type: pane,
                                                   id: entry.id,
                                                   name: entry.name,
                                                   role: 'member',
                                                })
                                             }
                                          >
                                             {entry.name}
                                          </CommandItem>
                                       ))}
                                 </CommandGroup>
                              </CommandList>
                           </Command>
                        )}
                     </PopoverContent>
                  </Popover>
               </div>

               <div className="flex justify-end">
                  <Button
                     size="sm"
                     disabled={busy || name.trim() === '' || leader === ''}
                     onClick={() => void submit()}
                  >
                     {t('create.create')}
                  </Button>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}
