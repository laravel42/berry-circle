import { BerryMark } from '@/components/brand/berry-mark';
import { SidebarTrigger } from '@/components/ui/sidebar';

export default function Header() {
   return (
      <header className="flex h-10 w-full items-center justify-between border-b px-4 sm:px-6">
         <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger />
            <BerryMark size="sm" tone="neutral" state="hollow" label="Runs" />
            <span className="truncate text-sm">runs</span>
         </div>
         <span className="text-xs font-normal text-muted-foreground">ledger</span>
      </header>
   );
}
