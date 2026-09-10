'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Switch } from '@/components/ui/switch';
import { BerryApiError } from '@/lib/api';
import { listSkills, setSkillForAgent, type Skill } from '@/lib/skills';

/** Which catalogue skills this agent carries into its tasks. */
export default function AgentSkillsTab({ agentId }: { agentId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const [skills, setSkills] = useState<Skill[] | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      listSkills({ agentId })
         .then((found) => {
            if (!cancelled) setSkills(found);
         })
         .catch((failure: unknown) => {
            if (!cancelled) {
               setError(failure instanceof BerryApiError ? failure.message : 'Skills could not be loaded.');
            }
         });
      return () => {
         cancelled = true;
      };
   }, [agentId]);

   const toggle = async (skill: Skill, enabled: boolean) => {
      // Optimistic: the switch moves at once, and moves back if the server refuses.
      setSkills((current) =>
         current?.map((entry) => (entry.id === skill.id ? { ...entry, agentEnabled: enabled } : entry)) ?? null
      );
      try {
         await setSkillForAgent(skill.id, agentId, enabled);
      } catch (failure) {
         setSkills((current) =>
            current?.map((entry) =>
               entry.id === skill.id ? { ...entry, agentEnabled: skill.agentEnabled ?? null } : entry
            ) ?? null
         );
         toast.error(failure instanceof BerryApiError ? failure.message : 'The skill could not be changed.');
      }
   };

   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!skills) return <p className="text-muted-foreground">Loading skills…</p>;

   return (
      <div className="flex max-w-3xl flex-col gap-3">
         <p className="text-muted-foreground">
            Switched-on skills are written into this agent’s workspace for every task.{' '}
            <Link href={`/${orgId}/skills`} className="text-foreground underline-offset-2 hover:underline">
               Manage the catalogue
            </Link>
         </p>
         {skills.length === 0 ? (
            <p className="text-muted-foreground">This workspace has no skills yet.</p>
         ) : (
            <ul className="flex flex-col rounded-md border border-border">
               {skills.map((skill) => (
                  <li
                     key={skill.id}
                     className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                     <div className="min-w-0">
                        <p className="truncate font-medium">{skill.name}</p>
                        {skill.description ? (
                           <p className="line-clamp-1 text-muted-foreground">{skill.description}</p>
                        ) : null}
                     </div>
                     <Switch
                        checked={skill.agentEnabled === true}
                        onCheckedChange={(checked) => void toggle(skill, checked)}
                        aria-label={`Use ${skill.name}`}
                     />
                  </li>
               ))}
            </ul>
         )}
      </div>
   );
}
