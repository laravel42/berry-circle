'use client';

import { Button } from '@/components/ui/button';
import {
   attachmentObjectUrl,
   isImageAttachment,
   loadIssueAttachments,
   uploadIssueAttachment,
   type ApiAttachment,
} from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import { ImageIcon, Loader2, Paperclip } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImageViewer, type ViewerImage } from './image-viewer';

/**
 * The description, and the files that belong with it.
 *
 * Dropping a screenshot onto the text is how people attach evidence to a bug,
 * and before this the description was an inert textarea: the only way in was a
 * button further down the page, under a different heading. The drop target is
 * the description itself because that is where the pointer already is.
 *
 * Images get a strip under the text and open in a viewer that steps through
 * all of them, since the second screenshot is usually the point.
 */
export function IssueDescription({
   issueId,
   issueRef,
   description,
}: {
   issueId: string;
   issueRef: string;
   description: string;
}) {
   const t = useTranslations('issueDetail.description');
   const updateIssueDescription = useIssuesStore((state) => state.updateIssueDescription);
   const [attachments, setAttachments] = useState<ApiAttachment[]>([]);
   const [images, setImages] = useState<ViewerImage[]>([]);
   const [uploading, setUploading] = useState(false);
   const [dragging, setDragging] = useState(false);
   const [viewerAt, setViewerAt] = useState<number | null>(null);
   const picker = useRef<HTMLInputElement>(null);
   const urls = useRef<string[]>([]);

   useEffect(() => {
      if (!issueRef) return;
      let cancelled = false;
      void loadIssueAttachments(issueRef)
         .then((loaded) => {
            if (!cancelled) setAttachments(loaded);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [issueRef]);

   // Blob URLs are made once per image and revoked when this unmounts; each
   // one holds the whole file, so leaking them leaks the pictures.
   useEffect(() => {
      let cancelled = false;
      const pictures = attachments.filter(isImageAttachment);
      void Promise.all(
         pictures.map(async (attachment) => {
            const url = await attachmentObjectUrl(attachment).catch(() => null);
            return url ? { id: attachment.id, name: attachment.fileName, url } : null;
         })
      ).then((loaded) => {
         const resolved = loaded.filter((entry): entry is ViewerImage => entry !== null);
         if (cancelled) {
            resolved.forEach((entry) => URL.revokeObjectURL(entry.url));
            return;
         }
         urls.current.forEach((url) => URL.revokeObjectURL(url));
         urls.current = resolved.map((entry) => entry.url);
         setImages(resolved);
      });
      return () => {
         cancelled = true;
      };
   }, [attachments]);

   useEffect(
      () => () => {
         urls.current.forEach((url) => URL.revokeObjectURL(url));
         urls.current = [];
      },
      []
   );

   const upload = useCallback(
      async (files: FileList | File[] | null) => {
         const list = files ? Array.from(files) : [];
         if (list.length === 0) return;
         setUploading(true);
         try {
            for (const file of list) {
               const saved = await uploadIssueAttachment(issueRef, file);
               setAttachments((current) => [
                  saved,
                  ...current.filter((entry) => entry.id !== saved.id),
               ]);
            }
         } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : t('uploadFailed'));
         } finally {
            setUploading(false);
            if (picker.current) picker.current.value = '';
         }
      },
      [issueRef, t]
   );

   return (
      <div className="mt-3">
         <div
            onDragOver={(event) => {
               event.preventDefault();
               setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
               event.preventDefault();
               setDragging(false);
               void upload(event.dataTransfer.files);
            }}
            className={cn(
               'rounded-sm border border-transparent transition-colors',
               dragging && 'border-dashed border-status-info bg-status-info/5'
            )}
         >
            <DescriptionTextarea
               value={description}
               onCommit={(markdown) => {
                  if (markdown.trim() === description.trim()) return;
                  updateIssueDescription(issueId, markdown);
               }}
               placeholder={dragging ? t('dropHere') : 'Add description…'}
               aria-label="Task description"
            />
         </div>

         <div className="mt-1 flex items-center gap-1">
            <Button
               variant="ghost"
               size="xs"
               disabled={uploading}
               onClick={() => picker.current?.click()}
            >
               {uploading ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
               ) : (
                  <Paperclip className="mr-1 size-3.5" />
               )}
               {uploading ? t('uploading') : t('upload')}
            </Button>
            <input
               ref={picker}
               type="file"
               multiple
               className="hidden"
               onChange={(event) => void upload(event.target.files)}
            />
         </div>

         {images.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
               {images.map((image, index) => (
                  <li key={image.id}>
                     <button
                        type="button"
                        onClick={() => setViewerAt(index)}
                        className="flex items-center gap-1.5 rounded-sm border border-border/60 px-2 py-1 hover:bg-accent"
                     >
                        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="max-w-[160px] truncate">{image.name}</span>
                     </button>
                  </li>
               ))}
            </ul>
         ) : null}

         <ImageViewer
            images={images}
            startAt={viewerAt ?? 0}
            open={viewerAt !== null}
            onOpenChange={(open) => (open ? undefined : setViewerAt(null))}
         />
      </div>
   );
}
