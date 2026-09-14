'use client';

import type { ReactNode } from 'react';

import { BerryWordmark } from '@/components/brand/berry-mark';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthCardProps {
   title: string;
   description?: string;
   children: ReactNode;
   /** Rendered under the card (e.g. the cross-link to the other auth screen). */
   footer?: ReactNode;
}

/**
 * Centered auth scaffold shared by sign-in. It matches the boot
 * screen's language — `bg-background`, the Berry mark up top — so moving from
 * "loading" to "sign in" does not feel like a different app. The page keeps its
 * own form logic; this only owns the frame.
 */
export function AuthCard({ title, description, children, footer }: AuthCardProps) {
   return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
         <BerryWordmark size="lg" />
         <Card className="w-full max-w-sm">
            <CardHeader className="text-center">
               <CardTitle>
                  <h1>{title}</h1>
               </CardTitle>
               {description ? <CardDescription>{description}</CardDescription> : null}
            </CardHeader>
            <CardContent>{children}</CardContent>
         </Card>
         {footer ? <div className="text-muted-foreground">{footer}</div> : null}
      </div>
   );
}
