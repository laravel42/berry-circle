'use client';

/**
 * Goals list header. No action, deliberately: planning is what makes a goal and
 * it starts in a project, so the button lives there. Offering it here would
 * invite a goal with no project to hang off.
 */
export default function Header() {
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Goals</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               The tasks one plan produced, grouped inside their project. Berry makes a goal when
               you plan work in a project — there is nothing to start or write here.
            </p>
         </div>
      </header>
   );
}
