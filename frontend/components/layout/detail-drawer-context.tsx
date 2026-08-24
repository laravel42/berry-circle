'use client';

import { createContext, useContext } from 'react';

interface DetailDrawerContextValue {
   active: boolean;
   onClose?: () => void;
}

const DetailDrawerContext = createContext<DetailDrawerContextValue>({ active: false });

export function DetailDrawerProvider({
   children,
   onClose,
}: {
   children: React.ReactNode;
   onClose?: () => void;
}) {
   return (
      <DetailDrawerContext.Provider value={{ active: true, onClose }}>
         {children}
      </DetailDrawerContext.Provider>
   );
}

export function useInDetailDrawer(): boolean {
   return useContext(DetailDrawerContext).active;
}

export function useDetailDrawerClose(): (() => void) | undefined {
   return useContext(DetailDrawerContext).onClose;
}
