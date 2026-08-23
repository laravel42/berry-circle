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
   maxWidth?: number;
}

/** Wide right drawer for intercepted detail routes; dismiss via overlay, Esc, or router.back(). */
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
               'flex h-full inset-y-0 right-0 flex-col gap-0 border-l bg-container p-0 sm:max-w-none',
               maxWidth ? 'left-auto max-w-none' : 'left-0 w-auto max-w-none md:left-[244px]'
            )}
            style={
               maxWidth
                  ? { width: `min(${maxWidth}px, calc(100vw - 244px))` }
                  : undefined
            }
         >
            <DetailDrawerProvider onClose={dismiss}>
               {header}
               <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
            </DetailDrawerProvider>
         </SheetContent>
      </Sheet>
   );
}
