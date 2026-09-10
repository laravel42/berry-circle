'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { BerryApiError } from '@/lib/api';
import { listSkills, type Skill } from '@/lib/skills';

const SOURCE_LABEL: Record<Skill['source']['kind'], string> = {
   manual: 'Manual',
   github: 'GitHub',
   zip: 'Zip',
};

interface SkillsListProps {
   query: string;
   /** Bumped by the header after a create or import, to reload the list. */
   version: number;
}

export default function SkillsList({ query, version }: SkillsListProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const [skills, setSkills] = useState<Skill[] | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      const timer = setTimeout(() => {
         listSkills({ q: query.trim() || undefined })
            .then((found) => {
               if (cancelled) return;
               setSkills(found);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (cancelled) return;
               setError(failure instanceof BerryApiError ? failure.message : 'Skills could not be loaded.');
            });
      }, 250);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [query, version]);

   if (error) {
      return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   }
   if (skills === null) {
      return <p className="px-6 py-8 text-muted-foreground">Loading skills…</p>;
   }
   if (skills.length === 0) {
      return (
         <p className="px-6 py-8 text-muted-foreground">
            {query.trim()
               ? 'No skill matches that search.'
               : 'No skills yet. Create one, or import a folder from GitHub or a zip.'}
         </p>
      );
   }

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Skill</div>
            <div className="hidden w-25 shrink-0 md:block">Source</div>
            <div className="w-20 shrink-0 text-right">Files</div>
         </div>
         {skills.map((skill) => (
            <Link
               key={skill.id}
               href={`/${orgId}/skills/${skill.id}`}
               className="flex w-full items-center border-b border-muted-foreground/5 px-6 py-3 last:border-b-0 hover:bg-sidebar/50"
            >
               <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                     <span className="truncate font-medium leading-none">{skill.name}</span>
                     {skill.labels.map((label) => (
                        <span
                           key={label}
                           className="shrink-0 rounded border border-border px-1.5 py-px text-muted-foreground"
                        >
                           {label}
                        </span>
                     ))}
                  </div>
                  {skill.description ? (
                     <p className="mt-0.5 line-clamp-2 text-muted-foreground">{skill.description}</p>
                  ) : null}
               </div>
               <div className="hidden w-25 shrink-0 text-muted-foreground md:block">
                  {SOURCE_LABEL[skill.source.kind]}
               </div>
               <div className="w-20 shrink-0 text-right text-muted-foreground">{skill.files.length}</div>
            </Link>
         ))}
      </div>
   );
}
