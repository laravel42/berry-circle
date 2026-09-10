'use client';

import { Button } from '@/components/ui/button';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { createJoinLink, joinLinkUrl, loadJoinLinks, revokeJoinLink, type JoinLink } from '@/lib/join-links';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Shareable join links. The link itself is shown once, right after creation:
 * the server keeps only a hash, so a lost link is revoked and replaced.
 */
export default function JoinLinksSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const links = useSettingsResource<JoinLink[]>(
      () => (workspaceId ? loadJoinLinks(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
   const [expiry, setExpiry] = useState('7');
   const [fresh, setFresh] = useState<string | null>(null);

   const create = async () => {
      try {
         const created = await createJoinLink(workspaceId, {
            role,
            ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
         });
         links.set([created, ...(links.value ?? [])]);
         setFresh(joinLinkUrl(created.token));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The link could not be created.');
      }
   };

   const copy = async (url: string) => {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
   };

   const state = (link: JoinLink) =>
      link.revokedAt
         ? 'revoked'
         : link.expiresAt && new Date(link.expiresAt) < new Date()
           ? 'expired'
           : link.maxUses !== null && link.useCount >= link.maxUses
             ? 'used up'
             : 'active';

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display">Join links</h1>
            <p className="text-muted-foreground">Anyone with a link can join this workspace at its role.</p>
         </div>
         <div className="flex gap-2 rounded-md border p-3">
            <Select value={role} onValueChange={(value) => setRole(value as 'admin' | 'member' | 'viewer')}>
               <SelectTrigger className="w-36">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
               </SelectContent>
            </Select>
            <Select value={expiry} onValueChange={setExpiry}>
               <SelectTrigger className="w-40">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="1">Expires in 1 day</SelectItem>
                  <SelectItem value="7">Expires in 7 days</SelectItem>
                  <SelectItem value="30">Expires in 30 days</SelectItem>
                  <SelectItem value="never">Never expires</SelectItem>
               </SelectContent>
            </Select>
            <Button onClick={() => void create()}>Create link</Button>
         </div>
         {fresh ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
               <code className="min-w-0 flex-1 truncate">{fresh}</code>
               <Button size="sm" variant="secondary" onClick={() => void copy(fresh)}>
                  Copy
               </Button>
            </div>
         ) : null}
         {links.error ? <p role="alert" className="text-muted-foreground">{links.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(links.value ?? []).map((link) => (
               <li key={link.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>
                     {link.role} <span className="text-muted-foreground">· {state(link)} · used {link.useCount}</span>
                  </span>
                  {state(link) === 'active' ? (
                     <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                           void links.mutate(
                              (links.value ?? []).map((entry) =>
                                 entry.id === link.id ? { ...entry, revokedAt: new Date().toISOString() } : entry
                              ),
                              () => revokeJoinLink(workspaceId, link.id)
                           )
                        }
                     >
                        Revoke
                     </Button>
                  ) : null}
               </li>
            ))}
         </ul>
      </div>
   );
}
