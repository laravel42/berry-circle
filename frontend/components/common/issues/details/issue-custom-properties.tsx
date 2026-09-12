'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { User } from '@/data/users';
import { loadWorkspaceMembers } from '@/lib/members';
import {
   clearIssueProperty,
   loadIssueProperties,
   loadProperties,
   setIssueProperty,
   type PropertyDefinition,
} from '@/lib/properties';
import { useSessionStore } from '@/store/session-store';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

type Person = { type: 'user' | 'agent'; id: string };
const NONE = '__none__';

/** A value the reader would call empty, whatever its field's type. */
function isEmpty(value: unknown): boolean {
   return (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
   );
}

/**
 * The workspace's own fields on this task.
 *
 * Every defined field used to be rendered on every task, which turns a
 * sidebar into a form: twelve rows, ten of them blank. Now a field appears
 * once it has a value or once someone asks for it by name, which is what the
 * "add property" menu is for.
 *
 * Archived definitions are shown but not editable. Hiding them would make a
 * value that is really there look like it is not, and letting them be edited
 * would let a task acquire a field the workspace has retired.
 */
export function IssueCustomProperties({ issueRef }: { issueRef: string }) {
   const t = useTranslations('issueDetail.properties');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
   const [values, setValues] = useState<Record<string, unknown>>({});
   const [members, setMembers] = useState<User[]>([]);
   const [revealed, setRevealed] = useState<string[]>([]);

   useEffect(() => {
      if (!workspaceId || !issueRef) return;
      let cancelled = false;
      void Promise.all([
         loadProperties(workspaceId),
         loadIssueProperties(issueRef),
         loadWorkspaceMembers(workspaceId),
      ])
         .then(([defs, current, people]) => {
            if (cancelled) return;
            setDefinitions(defs);
            setValues(Object.fromEntries(current.map((entry) => [entry.propertyId, entry.value])));
            setMembers(people);
            setRevealed([]);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspaceId, issueRef]);

   const save = (propertyId: string, value: unknown) => {
      const previous = values[propertyId];
      setValues((current) => ({ ...current, [propertyId]: value }));
      const write = isEmpty(value)
         ? clearIssueProperty(issueRef, propertyId)
         : setIssueProperty(issueRef, propertyId, value);
      void write.catch((cause: unknown) => {
         setValues((current) => ({ ...current, [propertyId]: previous }));
         toast.error(cause instanceof Error ? cause.message : t('saveFailed'));
      });
   };

   const shown = useMemo(
      () =>
         definitions.filter(
            (definition) => !isEmpty(values[definition.id]) || revealed.includes(definition.id)
         ),
      [definitions, values, revealed]
   );

   const addable = useMemo(
      () =>
         definitions.filter(
            (definition) =>
               definition.archivedAt === null &&
               isEmpty(values[definition.id]) &&
               !revealed.includes(definition.id)
         ),
      [definitions, values, revealed]
   );

   if (definitions.length === 0) return null;

   return (
      <Section
         title={t('title')}
         action={
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button
                     variant="ghost"
                     size="icon"
                     className="size-6"
                     aria-label={t('addProperty')}
                     title={t('addProperty')}
                  >
                     <Plus className="size-3.5" />
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                  {addable.length === 0 ? (
                     <DropdownMenuItem disabled>{t('noProperties')}</DropdownMenuItem>
                  ) : (
                     addable.map((definition) => (
                        <DropdownMenuItem
                           key={definition.id}
                           onClick={() => setRevealed((current) => [...current, definition.id])}
                        >
                           {definition.name}
                        </DropdownMenuItem>
                     ))
                  )}
               </DropdownMenuContent>
            </DropdownMenu>
         }
      >
         {shown.length === 0 ? (
            <p className="text-muted-foreground">{t('noLabels')}</p>
         ) : (
            <div className="flex flex-col gap-2">
               {shown.map((definition) => {
                  const archived = definition.archivedAt !== null;
                  return (
                     <label key={definition.id} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 shrink items-center gap-1.5 text-muted-foreground">
                           <span className="truncate">{definition.name}</span>
                           {archived ? (
                              <span
                                 title={t('archivedHint')}
                                 className="shrink-0 rounded bg-accent px-1.5"
                              >
                                 {t('archived')}
                              </span>
                           ) : null}
                        </span>
                        <FieldEditor
                           definition={definition}
                           value={values[definition.id]}
                           members={members}
                           readOnly={archived}
                           onChange={(next) => save(definition.id, next)}
                        />
                     </label>
                  );
               })}
            </div>
         )}
      </Section>
   );
}

function FieldEditor({
   definition,
   value,
   members,
   readOnly,
   onChange,
}: {
   definition: PropertyDefinition;
   value: unknown;
   members: User[];
   readOnly: boolean;
   onChange: (next: unknown) => void;
}) {
   // One place, rather than a disabled prop on nine controls: an archived
   // field is read in exactly the same layout, without an editor.
   if (readOnly) {
      return <ReadOnlyValue definition={definition} value={value} members={members} />;
   }

   switch (definition.kind) {
      case 'boolean':
         return (
            <Checkbox
               checked={value === true}
               onCheckedChange={(checked) => onChange(checked === true)}
            />
         );
      case 'number':
         return (
            <Input
               type="number"
               className="h-7 w-32"
               defaultValue={typeof value === 'number' ? value : ''}
               onBlur={(event) =>
                  onChange(event.target.value === '' ? null : Number(event.target.value))
               }
            />
         );
      case 'date':
         return (
            <Input
               type="date"
               className="h-7 w-36"
               defaultValue={typeof value === 'string' ? value : ''}
               onChange={(event) => onChange(event.target.value || null)}
            />
         );
      case 'select':
         return (
            <Select
               value={typeof value === 'string' ? value : NONE}
               onValueChange={(next) => onChange(next === NONE ? null : next)}
            >
               <SelectTrigger className="h-7 w-36">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {definition.options.map((option) => (
                     <SelectItem key={option.id} value={option.id}>
                        {option.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         );
      case 'multi_select': {
         const selected = Array.isArray(value) ? (value as string[]) : [];
         return (
            <div className="flex flex-wrap justify-end gap-1">
               {definition.options.map((option) => {
                  const on = selected.includes(option.id);
                  return (
                     <button
                        key={option.id}
                        type="button"
                        aria-pressed={on}
                        className="rounded-full border px-2 py-0.5"
                        style={on ? { borderColor: option.color, color: option.color } : undefined}
                        onClick={() =>
                           onChange(
                              on
                                 ? selected.filter((id) => id !== option.id)
                                 : [...selected, option.id]
                           )
                        }
                     >
                        {option.name}
                     </button>
                  );
               })}
            </div>
         );
      }
      case 'person':
      case 'multi_person': {
         const people =
            definition.kind === 'person'
               ? value
                  ? [value as Person]
                  : []
               : ((value as Person[] | undefined) ?? []);
         const first = people[0];
         return (
            <Select
               value={first?.id ?? NONE}
               onValueChange={(next) => {
                  const person: Person | null = next === NONE ? null : { type: 'user', id: next };
                  if (definition.kind === 'person') onChange(person);
                  else
                     onChange(
                        person ? [...people.filter((entry) => entry.id !== person.id), person] : []
                     );
               }}
            >
               <SelectTrigger className="h-7 w-40">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NONE}>Nobody</SelectItem>
                  {members.map((member) => (
                     <SelectItem key={member.id} value={member.id}>
                        {member.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         );
      }
      default:
         return (
            <Input
               className="h-7 w-40"
               type={definition.kind === 'url' ? 'url' : 'text'}
               defaultValue={typeof value === 'string' ? value : ''}
               onBlur={(event) => onChange(event.target.value.trim() || null)}
            />
         );
   }
}

function ReadOnlyValue({
   definition,
   value,
   members,
}: {
   definition: PropertyDefinition;
   value: unknown;
   members: User[];
}) {
   const names = (ids: Person[]) =>
      ids
         .map((person) => members.find((member) => member.id === person.id)?.name ?? person.id)
         .join(', ');

   let text = '—';
   if (definition.kind === 'boolean') text = value === true ? '✓' : '—';
   else if (definition.kind === 'select') {
      text = definition.options.find((option) => option.id === value)?.name ?? '—';
   } else if (definition.kind === 'multi_select' && Array.isArray(value)) {
      text =
         (value as string[])
            .map((id) => definition.options.find((option) => option.id === id)?.name ?? id)
            .join(', ') || '—';
   } else if (definition.kind === 'person' && value) text = names([value as Person]);
   else if (definition.kind === 'multi_person' && Array.isArray(value)) {
      text = names(value as Person[]) || '—';
   } else if (!isEmpty(value)) text = String(value);

   return <span className="min-w-0 truncate text-muted-foreground">{text}</span>;
}
