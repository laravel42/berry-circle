'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function HeaderNav() {
   const { orgId } = useParams<{ orgId: string }>();

   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Agents</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  AI teammates that pick up issues, comment, and update status.{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     Learn more
                  </a>
               </p>
            </div>
            <Button size="xs" variant="secondary" asChild>
               <Link href={`/${orgId}/agents/new`}>
                  <Plus className="size-4" />
                  New agent
               </Link>
            </Button>
         </div>
      </div>
   );
}
