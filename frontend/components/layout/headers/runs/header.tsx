export default function Header() {
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Runtimes</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Execution ledger for agent work — status, events, usage, and cost per run.{' '}
               <a href="" className="text-foreground underline-offset-2 hover:underline">
                  Learn more
               </a>
            </p>
         </div>
      </header>
   );
}
