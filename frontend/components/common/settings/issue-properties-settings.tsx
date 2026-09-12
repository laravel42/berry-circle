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
import { Switch } from '@/components/ui/switch';
import {
   archiveProperty,
   createProperty,
   loadProperties,
   MAX_ACTIVE_PROPERTIES,
   PROPERTY_KIND_LABELS,
   PROPERTY_KINDS,
   updateProperty,
   type PropertyDefinition,
   type PropertyKind,
} from '@/lib/properties';
import { useSessionStore } from '@/store/session-store';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace task fields.
 *
 * Kind is fixed at creation: stored values were checked against it, and a
 * field that changed type would be a field whose existing values no longer
 * mean anything. Options are typed as a comma list; ids are derived from
 * names.
 *
 * Archiving is a soft delete, so the values already on tasks survive it and
 * come back if the field does. That is only true if there is a way back, so
 * the archived rows are listed behind a toggle and can be restored — which is
 * also why "archive" needs no confirmation and no warning: nothing is lost.
 *
 * The count beside the heading is the point of the bound. Every active field
 * is a row in the task panel that everybody carries, so the cost of one more
 * is not paid by whoever adds it.
 */
const OPTION_COLORS = ['#6366f1', '#f97316', '#347b5a', '#9b6715', '#397caf', '#b4436c'];

function optionsFrom(raw: string) {
   return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({
         id:
            name
               .toLowerCase()
               .replace(/[^a-z0-9]+/g, '-')
               .replace(/^-+|-+$/g, '')
               .slice(0, 40) || `option-${index}`,
         name,
         color: OPTION_COLORS[index % OPTION_COLORS.length] ?? '#6366f1',
      }));
}

export default function IssuePropertiesSettings() {
   const t = useTranslations('workspaceAdmin.properties');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const properties = useSettingsResource<PropertyDefinition[]>(
      () =>
         workspaceId
            ? loadProperties(workspaceId, true)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );
   const [name, setName] = useState('');
   const [kind, setKind] = useState<PropertyKind>('text');
   const [options, setOptions] = useState('');
   const [creating, setCreating] = useState(false);
   const [showArchived, setShowArchived] = useState(false);
   const isSelect = kind === 'select' || kind === 'multi_select';

   const all = useMemo(() => properties.value ?? [], [properties.value]);
   const active = useMemo(() => all.filter((entry) => entry.archivedAt === null), [all]);
   const archived = useMemo(() => all.filter((entry) => entry.archivedAt !== null), [all]);
   const full = active.length >= MAX_ACTIVE_PROPERTIES;

   const replace = (next: PropertyDefinition) =>
      all.map((entry) => (entry.id === next.id ? next : entry));

   const create = async () => {
      if (!name.trim()) return;
      setCreating(true);
      try {
         const created = await createProperty(workspaceId, {
            name: name.trim(),
            kind,
            ...(isSelect ? { options: optionsFrom(options) } : {}),
         });
         properties.set([...all, created]);
         setName('');
         setOptions('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('createFailed'));
      } finally {
         setCreating(false);
      }
   };

   const archive = (property: PropertyDefinition) =>
      void properties.mutate(replace({ ...property, archivedAt: new Date().toISOString() }), () =>
         archiveProperty(workspaceId, property.id)
      );

   const restore = async (property: PropertyDefinition) => {
      try {
         const restored = await updateProperty(workspaceId, property.id, { archived: false });
         properties.set(replace(restored));
      } catch (cause) {
         // The commonest reason is the bound: the workspace filled up while
         // this one was away, and saying so is more use than "failed".
         toast.error(cause instanceof Error ? cause.message : t('restoreFailed'));
      }
   };

   const line = (property: PropertyDefinition) => (
      <li key={property.id} className="flex items-center justify-between gap-3 px-3 py-2">
         <span className="min-w-0 truncate">
            {property.name}{' '}
            <span className="text-muted-foreground">· {PROPERTY_KIND_LABELS[property.kind]}</span>
            {property.options.length > 0 ? (
               <span className="text-muted-foreground">
                  {' '}
                  · {property.options.map((option) => option.name).join(', ')}
               </span>
            ) : null}
         </span>
         {property.archivedAt === null ? (
            <Button variant="ghost" size="sm" onClick={() => archive(property)}>
               {t('archive')}
            </Button>
         ) : (
            <Button variant="ghost" size="sm" onClick={() => void restore(property)}>
               {t('restore')}
            </Button>
         )}
      </li>
   );

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display">{t('title')}</h1>
            <p className="text-muted-foreground">{t('lead')}</p>
            <p className={full ? 'mt-1 text-status-danger' : 'mt-1 text-muted-foreground'}>
               {t('counter', { used: active.length, max: MAX_ACTIVE_PROPERTIES })}
            </p>
         </div>

         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input
                  placeholder={t('namePlaceholder')}
                  value={name}
                  disabled={full}
                  onChange={(event) => setName(event.target.value)}
               />
               <Select value={kind} onValueChange={(value) => setKind(value as PropertyKind)}>
                  <SelectTrigger className="w-40" disabled={full}>
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
               <Button
                  onClick={() => void create()}
                  disabled={creating || full || !name.trim() || (isSelect && !options.trim())}
               >
                  {t('add')}
               </Button>
            </div>
            {isSelect ? (
               <Input
                  placeholder={t('optionsPlaceholder')}
                  value={options}
                  disabled={full}
                  onChange={(event) => setOptions(event.target.value)}
               />
            ) : null}
            {/* The kind cannot change later, so it is worth saying here
                rather than after somebody has tried. */}
            <p className="text-muted-foreground">{t('kindIsFixed')}</p>
            {full ? <p className="text-status-danger">{t('atCapacity')}</p> : null}
         </div>

         {properties.error ? (
            <p role="alert" className="text-muted-foreground">
               {properties.error}
            </p>
         ) : null}

         <ul className="flex flex-col divide-y rounded-md border">
            {active.map(line)}
            {!properties.loading && active.length === 0 ? (
               <li className="px-3 py-4 text-muted-foreground">{t('empty')}</li>
            ) : null}
         </ul>

         {archived.length > 0 ? (
            <div className="flex flex-col gap-3">
               <label className="flex items-center gap-2">
                  <Switch checked={showArchived} onCheckedChange={setShowArchived} />
                  <span>{t('showArchived', { count: archived.length })}</span>
               </label>
               {showArchived ? (
                  <>
                     <p className="text-muted-foreground">{t('archivedLead')}</p>
                     <ul className="flex flex-col divide-y rounded-md border">
                        {archived.map(line)}
                     </ul>
                  </>
               ) : null}
            </div>
         ) : null}
      </div>
   );
}
