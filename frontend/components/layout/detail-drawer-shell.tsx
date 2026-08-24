'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback } from 'react';

import { DetailDrawerProvider } from '@/components/layout/detail-drawer-context';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

interface DetailDrawerShellProps {
   header?: ReactNode;
   children: ReactNode;
   open?: boolean;
   onClose?: () => void;
   /**
    * Override the global drawer ceiling, in pixels. Rarely needed — the
    * default comes from `--drawer-max-width` so every drawer stays consistent
    * without each call site repeating a number.
    */
   maxWidth?: number;
}

/** Offset of the workspace sidebar; a drawer never covers it. */
const SIDEBAR_OFFSET = '244px';

/**
 * Wide right drawer for intercepted detail routes; dismiss via overlay, Esc,
 * or router.back().
 *
 * Width is capped globally by `--drawer-max-width` and additionally clamped to
 * the space left beside the sidebar, so the drawer never covers navigation on
 * a narrow viewport. The cap is a token rather than a prop default so changing
 * it is one edit rather than an audit of every call site.
 */
export default function DetailDrawerShell({
   header,
   children,
   open = true,
   onClose,
   maxWidth,
}: DetailDrawerShellProps) {
   const router = useRouter();

   const dismiss = useCallback(() => {
      if (onClose) {
         onClose();
         return;
      }
      router.back();
   }, [onClose, router]);

   const handleOpenChange = useCallback(
      (next: boolean) => {
         if (!next) {
            dismiss();
         }
      },
      [dismiss]
   );

   return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
         <SheetContent
            side="right"
            hideClose
            className={cn(
               'flex h-full inset-y-0 right-0 left-auto flex-col gap-0 border-l bg-container p-0',
               'max-w-none sm:max-w-none'
            )}
            style={{
               width: `min(${
                  maxWidth ? `${maxWidth}px` : 'var(--drawer-max-width)'
               }, calc(100vw - ${SIDEBAR_OFFSET}))`,
            }}
         >
            <DetailDrawerProvider onClose={dismiss}>
               {header}
               <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
            </DetailDrawerProvider>
         </SheetContent>
      </Sheet>
   );
}
