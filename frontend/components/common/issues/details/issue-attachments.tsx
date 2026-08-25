'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   ApiAttachment,
   downloadAttachment,
   formatFileSize,
   loadIssueAttachments,
} from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { Bot, Download, FileText, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * Files attached to an issue: what people uploaded and what agents produced.
 *
 * Listed together deliberately. ADR-0006 made an agent's output an ordinary
 * attachment rather than a parallel store, and splitting them back apart in the
 * UI would undo the point — a reader wants the files on this issue, not two
 * lists differing by who happened to author them.
 */
export function IssueAttachments({ issueRef }: { issueRef: string }) {
   const [attachments, setAttachments] = useState<ApiAttachment[]>([]);
   const [pending, setPending] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      if (!issueRef) {
         setAttachments([]);
         return;
      }
      let cancelled = false;
      void loadIssueAttachments(issueRef)
         .then((loaded) => {
            if (!cancelled) setAttachments(loaded);
         })
         .catch(() => {
            if (!cancelled) setAttachments([]);
         });
      return () => {
         cancelled = true;
      };
   }, [issueRef]);

   const download = useCallback(async (attachment: ApiAttachment) => {
      setPending(attachment.id);
      setError(null);
      try {
         await downloadAttachment(attachment);
      } catch {
         // Named rather than silent: a download that does nothing looks like a
         // broken button, and the file may simply no longer be there.
         setError(`${attachment.fileName} could not be downloaded.`);
      } finally {
         setPending(null);
      }
   }, []);

   if (attachments.length === 0) return null;

   return (
      <div className="mt-6">
         <h3 className="mb-2 font-medium text-muted-foreground">
            Files ({attachments.length})
         </h3>
         <div className="flex flex-col">
            {attachments.map((attachment) => {
               const isAgent = attachment.uploader?.type === 'agent';
               return (
                  <div
                     key={attachment.id}
                     className="flex items-center gap-2.5 border-b border-border/50 py-2 min-w-0"
                  >
                     <FileText className="size-4 shrink-0 text-muted-foreground" />
                     <span className="truncate font-medium">{attachment.fileName}</span>
                     <span className="shrink-0 text-muted-foreground">
                        {formatFileSize(attachment.sizeBytes)}
                     </span>

                     {attachment.uploader ? (
                        <span
                           className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground"
                           title={
                              isAgent
                                 ? `Produced by ${attachment.uploader.name}`
                                 : `Uploaded by ${attachment.uploader.name}`
                           }
                        >
                           {isAgent ? (
                              <Bot className="size-3.5" />
                           ) : (
                              <Avatar className="size-4">
                                 <AvatarImage
                                    src={attachment.uploader.avatarUrl ?? undefined}
                                    alt={attachment.uploader.name}
                                 />
                                 <AvatarFallback>
                                    {attachment.uploader.name[0]}
                                 </AvatarFallback>
                              </Avatar>
                           )}
                           <span className="truncate">{attachment.uploader.name}</span>
                        </span>
                     ) : (
                        <span className="ml-auto" />
                     )}

                     <Button
                        variant="ghost"
                        size="icon"
                        className={cn('size-7 shrink-0')}
                        aria-label={`Download ${attachment.fileName}`}
                        disabled={pending === attachment.id}
                        onClick={() => void download(attachment)}
                     >
                        {pending === attachment.id ? (
                           <Loader2 className="size-4 animate-spin" />
                        ) : (
                           <Download className="size-4" />
                        )}
                     </Button>
                  </div>
               );
            })}
         </div>
         {error ? <p className="mt-2 text-destructive">{error}</p> : null}
      </div>
   );
}
