import type { ReactNode } from 'react';

/** One labelled block of the task properties sidebar. */
export function Section({
   title,
   action,
   children,
}: {
   title: string;
   action?: ReactNode;
   children: ReactNode;
}) {
   return (
      <div>
         <div className="mb-2 flex items-center justify-between gap-2 pb-[7px]">
            <span className="font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
               {title.toLowerCase()}
            </span>
            {action}
         </div>
         {children}
      </div>
   );
}
