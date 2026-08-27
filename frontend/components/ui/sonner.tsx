'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
   const { theme = 'system' } = useTheme();

   return (
      <Sonner
         theme={theme as ToasterProps['theme']}
         className="toaster group"
         // Bottom right, away from the rail and the tab strip: a toast is an
         // aside, and the corner furthest from what you are reading is where
         // an aside belongs.
         position="bottom-right"
         toastOptions={{
            classNames: {
               // Black at four-fifths, blurred, with a hairline of white
               // rather than a border colour. It reads as glass over the app
               // instead of a card in it, which is the difference between
               // something announcing itself and something interrupting.
               toast: [
                  'group toast',
                  'group-[.toaster]:bg-black/80 group-[.toaster]:text-white',
                  'group-[.toaster]:border-white/10 group-[.toaster]:backdrop-blur-md',
                  'group-[.toaster]:shadow-xl',
               ].join(' '),
               description: 'group-[.toast]:text-white/70',
               actionButton:
                  'group-[.toast]:bg-white/15 group-[.toast]:text-white font-medium hover:group-[.toast]:bg-white/25',
               cancelButton:
                  'group-[.toast]:bg-white/10 group-[.toast]:text-white/70 font-medium',
            },
         }}
         {...props}
      />
   );
};

export { Toaster };
