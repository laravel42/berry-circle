'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

/**
 * The images on a task, one at a time.
 *
 * Opening an image from a task used to mean downloading it, which is a strange
 * way to look at a screenshot someone pasted into a bug report. This steps
 * through every image on the task rather than showing only the one clicked,
 * because the second screenshot is almost always the reason the first was
 * worth opening.
 */

export interface ViewerImage {
   id: string;
   name: string;
   /** An object URL or a data URL; the caller owns fetching and revoking it. */
   url: string;
}

export function ImageViewer({
   images,
   startAt,
   open,
   onOpenChange,
}: {
   images: ViewerImage[];
   startAt: number;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const t = useTranslations('issueDetail.viewer');
   const [index, setIndex] = useState(startAt);

   useEffect(() => {
      if (open) setIndex(startAt);
   }, [open, startAt]);

   // Arrow keys on the window rather than on a focused element: the dialog
   // holds focus and the reader's hands are already on the arrows.
   useEffect(() => {
      if (!open || images.length === 0) return;
      const onKey = (event: KeyboardEvent) => {
         if (event.key === 'ArrowRight') {
            event.preventDefault();
            setIndex((current) => (current + 1) % images.length);
         }
         if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setIndex((current) => (current - 1 + images.length) % images.length);
         }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [open, images.length]);

   const current = images[Math.min(index, Math.max(0, images.length - 1))];
   if (images.length === 0) return null;

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="w-full gap-3 sm:max-w-[900px]">
            <DialogTitle className="sr-only">{t('label')}</DialogTitle>
            <div className="flex items-center justify-center">
               {current ? (
                  /* The source is a blob URL for a file the server streamed
                     behind the session header, so next/image cannot fetch it
                     and the optimiser has nothing to optimise. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                     src={current.url}
                     alt={current.name}
                     className="max-h-[70vh] w-auto max-w-full object-contain"
                  />
               ) : null}
            </div>
            <div className="flex items-center justify-between gap-3">
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('previous')}
                  disabled={images.length < 2}
                  onClick={() => setIndex((value) => (value - 1 + images.length) % images.length)}
               >
                  <ChevronLeft className="size-4" />
               </Button>
               <span className="min-w-0 truncate text-muted-foreground">
                  {current?.name} · {t('position', { index: index + 1, total: images.length })}
               </span>
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('next')}
                  disabled={images.length < 2}
                  onClick={() => setIndex((value) => (value + 1) % images.length)}
               >
                  <ChevronRight className="size-4" />
               </Button>
            </div>
         </DialogContent>
      </Dialog>
   );
}

export default ImageViewer;
