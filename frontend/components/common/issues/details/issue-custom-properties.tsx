'use client';

import { Checkbox } from '@/components/ui/checkbox';
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
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

type Person = { type: 'user' | 'agent'; id: string };
const NONE = '__none__';

/** The workspace's custom fields on this task, each edited in place. */
export function IssueCustomProperties({ issueRef }: { issueRef: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
   const [values, setValues] = useState<Record<string, unknown>>({});
   const [members, setMembers] = useState<User[]>([]);

   useEffect(() => {
      if (!workspaceId || !issueRef) return;
      let cancelled = false;
      void Promise.all([loadProperties(workspaceId), loadIssueProperties(issueRef), loadWorkspaceMembers(workspaceId)])
         .then(([defs, current, people]) => {
            if (cancelled) return;
            setDefinitions(defs);
            setValues(Object.fromEntries(current.map((entry) => [entry.propertyId, entry.value])));
            setMembers(people);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspaceId, issueRef]);

   const save = (propertyId: string, value: unknown) => {
      const previous = values[propertyId];
      setValues((current) => ({ ...current, [propertyId]: value }));
      const write =
         value === null || value === '' || (Array.isArray(value) && value.length === 0)
            ? clearIssueProperty(issueRef, propertyId)
            : setIssueProperty(issueRef, propertyId, value);
      void write.catch((cause: unknown) => {
         setValues((current) => ({ ...current, [propertyId]: previous }));
         toast.error(cause instanceof Error ? cause.message : 'The field could not be saved.');
      });
   };

   if (definitions.length === 0) return null;

   return (
      <Section title="Fields">
         <div className="flex flex-col gap-2">
            {definitions.map((definition) => {
               const value = values[definition.id];
               return (
                  <label key={definition.id} className="flex items-center justify-between gap-2">
                     <span className="shrink-0 text-muted-foreground">{definition.name}</span>
                     <FieldEditor definition={definition} value={value} members={members} onChange={(next) => save(definition.id, next)} />
                  </label>
               );
            })}
         </div>
      </Section>
   );
}

function FieldEditor({
   definition,
   value,
   members,
   onChange,
}: {
   definition: PropertyDefinition;
   value: unknown;
   members: User[];
   onChange: (next: unknown) => void;
}) {
   switch (definition.kind) {
      case 'boolean':
         return <Checkbox checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />;
      case 'number':
         return (
            <Input
               type="number"
               className="h-7 w-32"
               defaultValue={typeof value === 'number' ? value : ''}
               onBlur={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
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
            <Select value={typeof value === 'string' ? value : NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
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
                        onClick={() => onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
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
         const people = definition.kind === 'person' ? (value ? [value as Person] : []) : ((value as Person[] | undefined) ?? []);
         const first = people[0];
         return (
            <Select
               value={first?.id ?? NONE}
               onValueChange={(next) => {
                  const person: Person | null = next === NONE ? null : { type: 'user', id: next };
                  if (definition.kind === 'person') onChange(person);
                  else onChange(person ? [...people.filter((entry) => entry.id !== person.id), person] : []);
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
