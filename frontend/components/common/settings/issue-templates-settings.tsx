'use client';

import { Button } from '@/components/ui/button';
import { FileText, Plus } from 'lucide-react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';

/** Populated via the gateway API at runtime. */
const TEMPLATES: { name: string; meta: string }[] = [];

/** Workspace "Issue templates" settings. */
export default function IssueTemplatesSettings() {
   return (
      <SettingsShell
         title="Task templates"
         description="These templates are available when creating tasks for any team in the workspace. To create templates that only apply to specific teams, add them as team templates."
      >
         <SettingsSection>
            <SettingsCard>
               <SettingsRow
                  title={`${TEMPLATES.length} task template${TEMPLATES.length === 1 ? '' : 's'}`}
                  trailing={
                     <Button size="icon" variant="ghost" className="size-7">
                        <Plus className="size-4" />
                     </Button>
                  }
               />
               {TEMPLATES.map((template) => (
                  <SettingsRow
                     key={template.name}
                     icon={<FileText className="size-4" />}
                     title={template.name}
                     description={template.meta}
                     onClick={() => {}}
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
