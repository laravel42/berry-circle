'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTeamsStore } from '@/store/teams-store';
import { Check } from 'lucide-react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';

/** "Join or create a crew" settings page. */
export default function NewTeam() {
   const teams = useTeamsStore((state) => state.teams);
   const notJoined = teams.filter((team) => !team.joined);

   return (
      <SettingsShell
         title="Join or create a crew"
         description="Crews organize issues, cycles and projects around the people working together"
      >
         <SettingsSection title="Create a new crew">
            <SettingsCard>
               <div className="flex items-center gap-3 p-4">
                  <Input placeholder="Crew name, e.g. Platform" className="h-8 flex-1" />
                  <Button size="xs">Create crew</Button>
               </div>
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title="Join an existing crew">
            <SettingsCard>
               {notJoined.map((team) => (
                  <SettingsRow
                     key={team.id}
                     icon={<span className="text-sm">{team.icon}</span>}
                     title={team.name}
                     description={`${team.members.length} members · ${team.projects.length} projects`}
                     trailing={
                        <Button size="xs" variant="secondary">
                           <Check className="size-3.5" />
                           Join
                        </Button>
                     }
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
