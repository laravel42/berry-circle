'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';

import {
   PREVIEW_SIZE_LIMIT,
   attachmentObjectUrl,
   attachmentText,
   downloadAttachment,
   formatFileSize,
   getAttachment,
   previewKind,
   type ApiAttachment,
} from '@/lib/attachments';

/**
 * A file on a page of its own, reached by link.
 *
 * This exists for HTML: an agent's report, a coverage summary, a rendered
 * diff. Those have to be shown as a document rather than as text, and a
 * document from an untrusted source has to be shown somewhere it can do
 * nothing — hence the iframe with an empty `sandbox`, which withholds scripts,
 * forms, popups, navigation and same-origin access all at once, and a `srcDoc`
 * so the markup never becomes a resource on Berry's own origin.
 *
 * Everything else a preview can show is shown here too, so a link to a file is
 * never a dead end.
 */
export function AttachmentPreviewPage({ attachmentId }: { attachmentId: string }) {
   const t = useTranslations('navigation.attachments');
   const [attachment, setAttachment] = useState<ApiAttachment | null>(null);
   const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
   const [objectUrl, setObjectUrl] = useState<string | null>(null);
   const [text, setText] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      let created: string | null = null;

      const load = async () => {
         const found = await getAttachment(attachmentId);
         if (cancelled) return;
         if (!found) {
            setState('missing');
            return;
         }
         setAttachment(found);

         const kind = previewKind(found);
         if (found.sizeBytes > PREVIEW_SIZE_LIMIT || kind === 'unsupported') {
            setState('ready');
            return;
         }
         try {
            if (kind === 'html' || kind === 'text') {
               const body = await attachmentText(found);
               if (!cancelled) {
                  setText(body);
                  setState('ready');
               }
               return;
            }
            created = await attachmentObjectUrl(found);
            if (cancelled) {
               URL.revokeObjectURL(created);
               return;
            }
            setObjectUrl(created);
            setState('ready');
         } catch {
            if (!cancelled) setState('failed');
         }
      };
      void load();

      return () => {
         cancelled = true;
         if (created) URL.revokeObjectURL(created);
      };
   }, [attachmentId]);

   if (state === 'loading') {
      return <Centered>{t('loading')}</Centered>;
   }
   if (state === 'missing' || !attachment) {
      return <Centered>{t('notFound')}</Centered>;
   }
   if (state === 'failed') {
      return <Centered>{t('loadFailed')}</Centered>;
   }

   const kind = previewKind(attachment);
   const tooLarge = attachment.sizeBytes > PREVIEW_SIZE_LIMIT;

   return (
      <div className="flex h-full min-h-0 flex-col">
         <div className="flex items-center gap-3 border-b px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate font-medium">{attachment.fileName}</span>
            <span className="shrink-0 text-muted-foreground">
               {formatFileSize(attachment.sizeBytes)}
            </span>
            <button
               type="button"
               onClick={() => void downloadAttachment(attachment)}
               className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 transition-colors hover:bg-accent"
            >
               <Download className="size-3.5" />
               {t('download')}
            </button>
         </div>

         {tooLarge ? (
            <Centered>{t('tooLarge')}</Centered>
         ) : kind === 'html' && text !== null ? (
            <>
               <p className="border-b bg-muted/30 px-4 py-1.5 text-muted-foreground">
                  {t('sandboxNote')}
               </p>
               <iframe
                  // Empty sandbox: no scripts, no forms, no navigation, no
                  // same-origin. srcDoc rather than a URL so the document never
                  // exists as a resource anyone could be sent to directly.
                  sandbox=""
                  srcDoc={text}
                  title={attachment.fileName}
                  className="min-h-0 flex-1 bg-white"
               />
            </>
         ) : kind === 'text' && text !== null ? (
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4">
               {text}
            </pre>
         ) : kind === 'image' && objectUrl ? (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
               {/* eslint-disable-next-line @next/next/no-img-element */}
               <img
                  src={objectUrl}
                  alt={attachment.fileName}
                  className="max-h-full max-w-full object-contain"
               />
            </div>
         ) : kind === 'pdf' && objectUrl ? (
            <iframe src={objectUrl} title={attachment.fileName} className="min-h-0 flex-1" />
         ) : (
            <Centered>{t('unsupported')}</Centered>
         )}
      </div>
   );
}

function Centered({ children }: { children: React.ReactNode }) {
   return (
      <div className="flex flex-1 items-center justify-center p-10 text-center text-muted-foreground">
         {children}
      </div>
   );
}
