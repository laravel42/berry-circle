'use client';

import { reviewTimeAgo, type ReviewItem } from '@/lib/reviews';
import { Check, FileCode2, GitBranch, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DiffStat, InlineText } from './review-shared';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
   return (
      <section className="flex flex-col gap-2">
         <h3 className="font-medium">{title}</h3>
         {children}
      </section>
   );
}

/**
 * The evidence a decision is made on: what the task asked, what the agent
 * says it did, what the checks said, what changed, and any peer verdict.
 */
export function ReviewOverview({ item }: { item: ReviewItem }) {
   const { orgId } = useParams<{ orgId: string }>();
   const latest = item.verdicts[0];
   return (
      <div className="h-full overflow-y-auto">
         <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-8">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
               {item.author && <span>by agent {item.author.name}</span>}
               {item.run.completedAt && <span>delivered {reviewTimeAgo(item.run.completedAt)} ago</span>}
               {item.pullRequest?.branch && (
                  <span className="inline-flex items-center gap-1 font-mono">
                     <GitBranch className="size-3.5" />
                     {item.pullRequest.branch}
                  </span>
               )}
               <Link href={`/${orgId}/issue/${item.issue.identifier}`} className="hover:text-foreground">
                  open the task
               </Link>
            </div>

            {latest && latest.approved !== null && (
               <div className={`rounded-md border px-4 py-3 ${latest.approved ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5'}`}>
                  <p className="font-medium">
                     Peer review by {latest.reviewer}: {latest.approved ? 'approved' : 'sent back'}
                     {latest.attempt > 1 ? ` (attempt ${latest.attempt})` : ''}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-muted-foreground">{latest.reason}</p>
               </div>
            )}

            <Section title="What the agent says it did">
               {item.run.summary ? (
                  <p className="whitespace-pre-line leading-6"><InlineText text={item.run.summary} /></p>
               ) : (
                  <p className="text-muted-foreground">The run left no summary.</p>
               )}
            </Section>

            <Section title="Checks">
               {item.checks && item.checks.results.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                     {item.checks.results.map((result) => (
                        <li key={result.command} className="flex items-center gap-2 font-mono">
                           {result.passed ? <Check className="size-3.5 text-emerald-600" /> : <X className="size-3.5 text-red-500" />}
                           <span>{result.command}</span>
                           {!result.passed && <span className="text-muted-foreground">exit {result.exitCode ?? 'none'}</span>}
                        </li>
                     ))}
                     {!item.checks.complete && (
                        <li className="text-muted-foreground">The remaining checks did not run: the verification budget was spent.</li>
                     )}
                  </ul>
               ) : (
                  <p className="text-muted-foreground">The project defines no checks, so none ran.</p>
               )}
            </Section>

            <Section title="What changed">
               {item.delivery.committed ? (
                  <>
                     <div className="flex items-center gap-2">
                        <span>{item.delivery.filesChanged} files</span>
                        <DiffStat additions={item.delivery.insertions} deletions={item.delivery.deletions} />
                        {item.pullRequest?.url && (
                           <a href={item.pullRequest.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                              pull request #{item.pullRequest.number}
                           </a>
                        )}
                     </div>
                     <ul className="flex flex-col gap-1">
                        {item.delivery.files.map((file) => (
                           <li key={file} className="flex items-center gap-1.5 font-mono">
                              <FileCode2 className="size-3.5 text-muted-foreground shrink-0" />
                              {file}
                           </li>
                        ))}
                     </ul>
                  </>
               ) : (
                  <p className="text-muted-foreground">The run committed nothing. Its answer is the comment on the task.</p>
               )}
            </Section>
         </div>
      </div>
   );
}
