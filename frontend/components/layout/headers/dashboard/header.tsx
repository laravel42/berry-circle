export default function Header() {
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Dashboard</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Runs, failures, spend and task status for the whole workspace.
            </p>
         </div>
      </header>
   );
}
