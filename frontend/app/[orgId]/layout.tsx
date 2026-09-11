import { FloatingChat } from '@/components/common/chat/floating-chat';
import { BerryShell } from '@/components/layout/shell/berry-shell';

/**
 * Workspace layout: the shell frames every workspace route.
 *
 * The shell owns the rail, the tab strip, and the scrolling canvas, so pages
 * below it render content only. `MainLayout` therefore no longer draws a
 * sidebar of its own — two sidebars is what you get if both keep their chrome.
 *
 * Kept synchronous on purpose. Awaiting `params` here makes the layout async,
 * which breaks page-data collection for the intercepting routes in the
 * `@drawer` slot; the shell reads the workspace id from `useParams` instead.
 */
export default function OrgLayout({
   children,
   drawer,
}: {
   children: React.ReactNode;
   drawer: React.ReactNode;
}) {
   return (
      <BerryShell>
         {children}
         {drawer}
         {/* Chat from anywhere except the chat page, which is this window's
             full-size counterpart. */}
         <FloatingChat />
      </BerryShell>
   );
}
