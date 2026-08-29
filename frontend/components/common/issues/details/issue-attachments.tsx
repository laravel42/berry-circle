'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   ApiAttachment,
   downloadAttachment,
   formatFileSize,
   loadIssueAttachments,
   uploadIssueAttachment,
} from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { Bot, Download, FileText, Loader2, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Files a person put on this issue.
 *
 * Agent output is no longer here. It was, under ADR-0006, on the reasoning that
 * a reader wants the files on an issue rather than two lists split by author —
 * but an agent does not attach a file, it produces a tree, and the attachment
 * table could not hold a path. IssueArtifacts renders that tree; this stays
 * what it always was, a list of uploads.
 */
export function IssueAttachments({ issueRef }: { issueRef: string }) {
   const [attachments, setAttachments] = useState<ApiAttachment[]>([]);
   const [pending, setPending] = useState<string | null>(null);
   const [uploading, setUploading] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const picker = useRef<HTMLInputElement>(null);

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

   const upload = useCallback(
      async (files: FileList | null) => {
         if (!files || files.length === 0) return;
         setUploading(true);
         setError(null);
         try {
            for (const file of Array.from(files)) {
               const saved = await uploadIssueAttachment(issueRef, file);
               // Replaced rather than appended when it is the same file: the
               // server deduplicates by content, so a second drop of one
               // screenshot must not appear twice in the list.
               setAttachments((current) => [
                  saved,
                  ...current.filter((entry) => entry.id !== saved.id),
               ]);
            }
         } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The file could not be uploaded.');
         } finally {
            setUploading(false);
            if (picker.current) picker.current.value = '';
         }
      },
      [issueRef]
   );

   return (
      <div className="mt-6">
         <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-medium text-muted-foreground">
               {attachments.length > 0 ? `Files (${attachments.length})` : 'Files'}
            </h3>
            <Button
               variant="ghost"
               size="sm"
               className="h-7"
               disabled={uploading}
               onClick={() => picker.current?.click()}
            >
               {uploading ? (
                  <Loader2 className="size-3.5 animate-spin" />
               ) : (
                  <Paperclip className="size-3.5" />
               )}
               {uploading ? 'Uploading…' : 'Add a file'}
            </Button>
            <input
               ref={picker}
               type="file"
               multiple
               className="hidden"
               onChange={(event) => void upload(event.target.files)}
            />
         </div>
         <div className="flex flex-col">
            {attachments.length === 0 ? (
               <p className="py-2 text-muted-foreground">No files yet.</p>
            ) : null}
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
