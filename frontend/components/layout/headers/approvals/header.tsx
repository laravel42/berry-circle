'use client';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApprovalsFilterStore, type ApprovalsView } from '@/store/approvals-filter-store';

export default function Header() {
   const { view, setView, mine, setMine } = useApprovalsFilterStore();
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Approvals</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  The decisions a person has to make before a plan starts, a task begins or an
                  agent acts outside Berry. Who may decide is the addressee, or anyone with that
                  role or a stronger one.
               </p>
            </div>
            <div className="flex shrink-0 items-center gap-4">
               <div className="flex items-center gap-2">
                  <Switch id="approvals-mine" checked={mine} onCheckedChange={setMine} />
                  <Label htmlFor="approvals-mine">Mine</Label>
               </div>
               <Tabs value={view} onValueChange={(value) => setView(value as ApprovalsView)}>
                  <TabsList className="h-8">
                     <TabsTrigger value="all">All</TabsTrigger>
                     <TabsTrigger value="pending">Pending</TabsTrigger>
                     <TabsTrigger value="resolved">Resolved</TabsTrigger>
                  </TabsList>
               </Tabs>
            </div>
         </div>
      </header>
   );
}
