'use client';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { PluginConfigField, PluginConfigValue } from '@/lib/plugins';
import { SettingsCard, SettingsRow } from './shared';

/** The settings a plugin declares, as form rows. Shared by install and detail. */
export function PluginConfigForm({
   fields,
   value,
   onChange,
   disabled,
}: {
   fields: PluginConfigField[];
   value: Record<string, PluginConfigValue>;
   onChange: (next: Record<string, PluginConfigValue>) => void;
   disabled?: boolean;
}) {
   if (fields.length === 0) return null;
   const set = (key: string, next: PluginConfigValue) => onChange({ ...value, [key]: next });
   return (
      <SettingsCard>
         {fields.map((field) => (
            <SettingsRow
               key={field.key}
               title={field.required ? `${field.label} *` : field.label}
               trailing={
                  field.type === 'boolean' ? (
                     <Switch
                        checked={value[field.key] === true}
                        disabled={disabled}
                        onCheckedChange={(checked) => set(field.key, checked)}
                     />
                  ) : (
                     <Input
                        className="h-8 w-56"
                        disabled={disabled}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={String(value[field.key] ?? '')}
                        onChange={(event) =>
                           set(
                              field.key,
                              field.type === 'number'
                                 ? Number(event.target.value)
                                 : event.target.value
                           )
                        }
                     />
                  )
               }
            />
         ))}
      </SettingsCard>
   );
}
