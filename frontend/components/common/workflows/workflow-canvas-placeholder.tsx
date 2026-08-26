'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { useWorkflow } from '@/hooks/use-workflow';

/**
 * Where the canvas editor will be. The React Flow adapter lands in the next
 * phase; until then the definition is shown as the JSON the API holds, so
 * a person can still see exactly what would run.
 */
export default function WorkflowCanvasPlaceholder({ workflowId }: { workflowId: string }) {
   const { workflow } = useWorkflow(workflowId);
   return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-container">
         <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-8">
            <div className="flex flex-col items-center rounded-md border border-dashed border-border px-6 py-10 text-center">
               <BerryMark size="lg" tone="neutral" state="hollow" label="Canvas placeholder" />
               <h2 className="mt-5 font-display tracking-[-0.025em]">
                  The canvas is not here yet.
               </h2>
               <p className="mt-2 max-w-md leading-relaxed text-muted-foreground">
                  The visual editor for steps and branches arrives with the next phase. Until then
                  the overview lists the steps, and the definition below is exactly what runs.
               </p>
            </div>
            {workflow && (
               <details
                  className="mt-6 rounded-md border border-border/60 bg-background px-3 py-2"
                  open
               >
                  <summary className="cursor-pointer font-medium">
                     Definition · v{workflow.version} · revision {workflow.revision}
                  </summary>
                  <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono leading-5">
                     {JSON.stringify(workflow.definition, null, 2)}
                  </pre>
               </details>
            )}
         </div>
      </div>
   );
}
