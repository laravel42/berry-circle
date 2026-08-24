import * as React from 'react';

import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
   ({ className, ...props }, ref) => {
      return (
         <textarea
            ref={ref}
            data-slot="textarea"
            className={cn(
               'border-input bg-background text-foreground placeholder:text-foreground/40 focus-visible:border-input focus-visible:ring-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
               className
            )}
            {...props}
         />
      );
   }
);
Textarea.displayName = 'Textarea';

export { Textarea };
