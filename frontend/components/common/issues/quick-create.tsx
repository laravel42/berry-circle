'use client';

import { Input } from '@/components/ui/input';
import { quickCreateIssue } from '@/lib/issue-tracking';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';

/** One line, Enter to create: a task on the workspace's default board. */
export function QuickCreate() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const addIssue = useIssuesStore((state) => state.addIssue);
   const [title, setTitle] = useState('');
   const [busy, setBusy] = useState(false);

   const submit = () => {
      if (!title.trim() || !workspaceId || busy) return;
      setBusy(true);
      void quickCreateIssue({ workspaceId, title: title.trim() })
         .then((issue) => {
            addIssue(issue);
            setTitle('');
         })
         .catch(() => toast.error('The task could not be created.'))
         .finally(() => setBusy(false));
   };

   return (
      <div className="border-b px-4 py-1.5">
         <Input
            className="h-8"
            placeholder="Quick add a task and press Enter"
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
         />
      </div>
   );
}
