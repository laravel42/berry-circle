'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
   ChevronLeft,
   ChevronRight,
   Download,
   ExternalLink,
   Link2,
   Maximize2,
   Minimize2,
   X,
   ZoomIn,
   ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
   PREVIEW_SIZE_LIMIT,
   attachmentObjectUrl,
   attachmentText,
   downloadAttachment,
   formatFileSize,
   previewKind,
   type ApiAttachment,
} from '@/lib/attachments';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

interface AttachmentPreviewProps {
   /** The whole list, so the arrows can move through it. */
   attachments: ApiAttachment[];
   /** Index of the file on screen; null closes the modal. */
   index: number | null;
   onIndexChange: (index: number | null) => void;
   /** Workspace slug, for the link the preview page lives at. */
   orgId: string;
}

/**
 * A file, full size, without leaving the task.
 *
 * Zoom is "fit" or a scale. Fit is the state the preview opens in and the one
 * double-click returns to, because the first question about a picture is what
 * it is, and only the second is what is in the corner of it. Panning exists
 * only once zoomed in — there is nothing to pan when the whole image is on
 * screen — and the pointer says so by changing shape.
 *
 * Nothing here renders a file it was not asked to: an unreadable type or an
 * oversized one says so and offers the download, rather than handing the
 * browser bytes and hoping.
 */
export function AttachmentPreview({
   attachments,
   index,
   onIndexChange,
   orgId,
}: AttachmentPreviewProps) {
   const t = useTranslations('navigation.attachments');
   const attachment = index === null ? undefined : attachments[index];

   const [objectUrl, setObjectUrl] = useState<string | null>(null);
   const [text, setText] = useState<string | null>(null);
   const [failed, setFailed] = useState(false);
   const [loading, setLoading] = useState(false);
   /** null means "fit to the window"; a number is an explicit scale. */
   const [zoom, setZoom] = useState<number | null>(null);
   const [offset, setOffset] = useState({ x: 0, y: 0 });
   const panFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

   const kind = attachment ? previewKind(attachment) : 'unsupported';
   const tooLarge = Boolean(attachment && attachment.sizeBytes > PREVIEW_SIZE_LIMIT);
   const renderable = Boolean(attachment) && !tooLarge && kind !== 'unsupported';

   // Load the bytes for the file on screen, and only that one. The object URL
   // is revoked when it is replaced or the modal closes: a blob held open is a
   // copy of the file kept in memory for as long as the tab lives.
   useEffect(() => {
      setZoom(null);
      setOffset({ x: 0, y: 0 });
      setFailed(false);
      setText(null);
      if (!attachment || !renderable) {
         setObjectUrl(null);
         return;
      }
      let cancelled = false;
      let created: string | null = null;
      setLoading(true);

      const load = async () => {
         try {
            if (kind === 'text') {
               const body = await attachmentText(attachment);
               if (!cancelled) setText(body);
               return;
            }
            created = await attachmentObjectUrl(attachment);
            if (cancelled) {
               URL.revokeObjectURL(created);
               return;
            }
            setObjectUrl(created);
         } catch {
            if (!cancelled) setFailed(true);
         } finally {
            if (!cancelled) setLoading(false);
         }
      };
      void load();

      return () => {
         cancelled = true;
         if (created) URL.revokeObjectURL(created);
         setObjectUrl(null);
      };
   }, [attachment, renderable, kind]);

   const move = useCallback(
      (step: number) => {
         if (index === null || attachments.length === 0) return;
         const next = (index + step + attachments.length) % attachments.length;
         onIndexChange(next);
      },
      [index, attachments.length, onIndexChange]
   );

   const zoomBy = useCallback(
      (factor: number) => {
         setZoom((current) => {
            const base = current ?? 1;
            return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base * factor));
         });
      },
      [setZoom]
   );

   // Arrows move between files; +/- zoom; 0 fits; 1 is actual size. Escape is
   // the dialog's own, so it is not handled here.
   useEffect(() => {
      if (index === null) return;
      const onKeyDown = (event: KeyboardEvent) => {
         if (event.isComposing) return;
         switch (event.key) {
            case 'ArrowLeft':
               event.preventDefault();
               move(-1);
               break;
            case 'ArrowRight':
               event.preventDefault();
               move(1);
               break;
            case '+':
            case '=':
               event.preventDefault();
               zoomBy(ZOOM_STEP);
               break;
            case '-':
               event.preventDefault();
               zoomBy(1 / ZOOM_STEP);
               break;
            case '0':
               event.preventDefault();
               setZoom(null);
               setOffset({ x: 0, y: 0 });
               break;
            case '1':
               event.preventDefault();
               setZoom(1);
               break;
            default:
               break;
         }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
   }, [index, move, zoomBy]);

   if (index === null || !attachment) return null;

   const previewHref = `/${orgId}/attachments/${attachment.id}/preview`;

   const copyLink = async () => {
      const url = `${window.location.origin}${previewHref}`;
      try {
         await navigator.clipboard.writeText(url);
         toast.success(t('copyLink'));
      } catch {
         toast.error(t('loadFailed'));
      }
   };

   const zoomed = zoom !== null && zoom > 1;

   const body = () => {
      if (tooLarge) {
         return <Message text={`${t('tooLarge')} (${formatFileSize(attachment.sizeBytes)})`} />;
      }
      if (kind === 'unsupported') return <Message text={t('unsupported')} />;
      if (failed) return <Message text={t('loadFailed')} />;
      if (loading) return <Message text={t('loading')} />;

      if (kind === 'image' && objectUrl) {
         return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
               src={objectUrl}
               alt={attachment.fileName}
               draggable={false}
               onDoubleClick={() => {
                  // Double-click is the shortest way between "show me all of
                  // it" and "show me it properly".
                  setZoom((current) => (current === 1 ? null : 1));
                  setOffset({ x: 0, y: 0 });
               }}
               onPointerDown={(event) => {
                  if (!zoomed) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  panFrom.current = {
                     x: event.clientX,
                     y: event.clientY,
                     ox: offset.x,
                     oy: offset.y,
                  };
               }}
               onPointerMove={(event) => {
                  const from = panFrom.current;
                  if (!from) return;
                  setOffset({
                     x: from.ox + (event.clientX - from.x),
                     y: from.oy + (event.clientY - from.y),
                  });
               }}
               onPointerUp={() => {
                  panFrom.current = null;
               }}
               onPointerCancel={() => {
                  panFrom.current = null;
               }}
               style={
                  zoom === null
                     ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                     : {
                          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                          transformOrigin: 'center',
                       }
               }
               className={zoomed ? 'cursor-grab active:cursor-grabbing' : ''}
            />
         );
      }

      if (kind === 'pdf' && objectUrl) {
         return <iframe src={objectUrl} title={attachment.fileName} className="size-full" />;
      }

      if (kind === 'html') {
         // Rendered on its own page, in a sandbox. Inlining someone's HTML in
         // the middle of the app is how a file becomes a script.
         return (
            <div className="flex flex-col items-center gap-3">
               <Message text={t('sandboxNote')} />
               <a
                  href={previewHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-md border px-3 py-1.5 hover:bg-accent"
               >
                  {t('openPage')}
               </a>
            </div>
         );
      }

      if (kind === 'text' && text !== null) {
         return (
            <pre className="size-full overflow-auto whitespace-pre-wrap break-words p-4 text-left">
               {text}
            </pre>
         );
      }

      return <Message text={t('loading')} />;
   };

   return (
      <Dialog open onOpenChange={(value) => !value && onIndexChange(null)}>
         <DialogContent
            showCloseButton={false}
            className="flex h-[85vh] w-[92vw] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
         >
            <DialogTitle className="sr-only">
               {t('preview', { name: attachment.fileName })}
            </DialogTitle>
            <DialogDescription className="sr-only">{attachment.fileName}</DialogDescription>

            <div className="flex items-center gap-2 border-b px-3 py-2">
               <span className="min-w-0 flex-1 truncate font-medium">{attachment.fileName}</span>
               <span className="shrink-0 text-muted-foreground">
                  {formatFileSize(attachment.sizeBytes)}
               </span>

               {kind === 'image' && renderable ? (
                  <>
                     <ToolbarButton label={t('zoomOut')} onClick={() => zoomBy(1 / ZOOM_STEP)}>
                        <ZoomOut className="size-4" />
                     </ToolbarButton>
                     <ToolbarButton label={t('zoomIn')} onClick={() => zoomBy(ZOOM_STEP)}>
                        <ZoomIn className="size-4" />
                     </ToolbarButton>
                     <ToolbarButton
                        label={zoom === null ? t('actualSize') : t('fit')}
                        onClick={() => {
                           setZoom((current) => (current === null ? 1 : null));
                           setOffset({ x: 0, y: 0 });
                        }}
                     >
                        {zoom === null ? (
                           <Maximize2 className="size-4" />
                        ) : (
                           <Minimize2 className="size-4" />
                        )}
                     </ToolbarButton>
                  </>
               ) : null}

               <ToolbarButton
                  label={t('download')}
                  onClick={() => void downloadAttachment(attachment)}
               >
                  <Download className="size-4" />
               </ToolbarButton>
               <ToolbarButton label={t('copyLink')} onClick={() => void copyLink()}>
                  <Link2 className="size-4" />
               </ToolbarButton>
               <a
                  href={previewHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={t('openInNewTab')}
                  title={t('openInNewTab')}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
               >
                  <ExternalLink className="size-4" />
               </a>
               <ToolbarButton label={t('close')} onClick={() => onIndexChange(null)}>
                  <X className="size-4" />
               </ToolbarButton>
            </div>

            <div
               onWheel={(event) => {
                  if (kind !== 'image' || !renderable) return;
                  zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
               }}
               className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30"
            >
               {attachments.length > 1 ? (
                  <ToolbarButton
                     label={t('previous')}
                     onClick={() => move(-1)}
                     className="absolute left-2 top-1/2 z-10 -translate-y-1/2 bg-background/80"
                  >
                     <ChevronLeft className="size-5" />
                  </ToolbarButton>
               ) : null}
               {body()}
               {attachments.length > 1 ? (
                  <ToolbarButton
                     label={t('next')}
                     onClick={() => move(1)}
                     className="absolute right-2 top-1/2 z-10 -translate-y-1/2 bg-background/80"
                  >
                     <ChevronRight className="size-5" />
                  </ToolbarButton>
               ) : null}
            </div>
         </DialogContent>
      </Dialog>
   );
}

function Message({ text }: { text: string }) {
   return <p className="max-w-sm px-6 text-center text-muted-foreground">{text}</p>;
}

function ToolbarButton({
   label,
   onClick,
   className,
   children,
}: {
   label: string;
   onClick: () => void;
   className?: string;
   children: React.ReactNode;
}) {
   return (
      <button
         type="button"
         onClick={onClick}
         aria-label={label}
         title={label}
         className={[
            'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
            'transition-colors hover:bg-accent hover:text-foreground',
            className ?? '',
         ].join(' ')}
      >
         {children}
      </button>
   );
}
