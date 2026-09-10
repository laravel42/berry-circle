'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import {
   archiveProperty,
   createProperty,
   loadProperties,
   PROPERTY_KIND_LABELS,
   PROPERTY_KINDS,
   type PropertyDefinition,
   type PropertyKind,
} from '@/lib/properties';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace task fields. Kind is fixed at creation: stored values were checked
 * against it. Options are typed as a comma list; ids are derived from names.
 */
const OPTION_COLORS = ['#6366f1', '#f97316', '#347b5a', '#9b6715', '#397caf', '#b4436c'];

function optionsFrom(raw: string) {
   return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({
         id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `option-${index}`,
         name,
         color: OPTION_COLORS[index % OPTION_COLORS.length] ?? '#6366f1',
      }));
}

export default function IssuePropertiesSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const properties = useSettingsResource<PropertyDefinition[]>(
      () => (workspaceId ? loadProperties(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [name, setName] = useState('');
   const [kind, setKind] = useState<PropertyKind>('text');
   const [options, setOptions] = useState('');
   const [creating, setCreating] = useState(false);
   const isSelect = kind === 'select' || kind === 'multi_select';

   const create = async () => {
      if (!name.trim()) return;
      setCreating(true);
      try {
         const created = await createProperty(workspaceId, {
            name: name.trim(),
            kind,
            ...(isSelect ? { options: optionsFrom(options) } : {}),
         });
         properties.set([...(properties.value ?? []), created]);
         setName('');
         setOptions('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The field could not be created.');
      } finally {
         setCreating(false);
      }
   };

   const archive = (property: PropertyDefinition) =>
      void properties.mutate(
         (properties.value ?? []).filter((entry) => entry.id !== property.id),
         () => archiveProperty(workspaceId, property.id)
      );

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display">Task fields</h1>
            <p className="text-muted-foreground">Custom fields every task in this workspace can carry.</p>
         </div>
         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input placeholder="Field name" value={name} onChange={(event) => setName(event.target.value)} />
               <Select value={kind} onValueChange={(value) => setKind(value as PropertyKind)}>
                  <SelectTrigger className="w-40">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     {PROPERTY_KINDS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                           {PROPERTY_KIND_LABELS[entry]}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Button onClick={() => void create()} disabled={creating || !name.trim() || (isSelect && !options.trim())}>
                  Add
               </Button>
            </div>
            {isSelect ? (
               <Input
                  placeholder="Options, comma separated"
                  value={options}
                  onChange={(event) => setOptions(event.target.value)}
               />
            ) : null}
         </div>
         {properties.error ? <p role="alert" className="text-muted-foreground">{properties.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(properties.value ?? []).map((property) => (
               <li key={property.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate">
                     {property.name}{' '}
                     <span className="text-muted-foreground">· {PROPERTY_KIND_LABELS[property.kind]}</span>
                     {property.options.length > 0 ? (
                        <span className="text-muted-foreground"> · {property.options.map((option) => option.name).join(', ')}</span>
                     ) : null}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => archive(property)}>
                     Archive
                  </Button>
               </li>
            ))}
            {!properties.loading && (properties.value ?? []).length === 0 ? (
               <li className="px-3 py-4 text-muted-foreground">No fields yet.</li>
            ) : null}
         </ul>
      </div>
   );
}
