'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, CircleHelp, MessageSquareWarning, ScrollText } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CHANGELOG_URL, DOCS_URL, FEEDBACK_URL } from '@/lib/help-links';
import { loadServerInfo } from '@/lib/server-info';
import { shellIconButton } from './shell-icon';

/**
 * The help control at the foot of the rail.
 *
 * The version belongs here rather than in settings because of when it is
 * wanted: at the moment someone is about to describe a problem. It is read
 * from the server that answered, not from the frontend build, since those are
 * two different things in a self-hosted deployment and only one of them is the
 * answer to "what am I running?".
 */
export function ShellHelp() {
   const t = useTranslations('navigation.sidebar');
   const [version, setVersion] = useState<string | null>(null);
   const [open, setOpen] = useState(false);

   // Asked for the first time the menu opens: it is one small call, and a
   // version nobody looks at is not worth a request on every page load.
   useEffect(() => {
      if (!open || version !== null) return;
      let cancelled = false;
      void loadServerInfo().then((info) => {
         if (!cancelled && info.version) setVersion(info.version);
      });
      return () => {
         cancelled = true;
      };
   }, [open, version]);

   const links: {
      key: 'docs' | 'changelog' | 'feedback';
      url: string | null;
      icon: typeof BookOpen;
   }[] = [
      { key: 'docs', url: DOCS_URL, icon: BookOpen },
      { key: 'changelog', url: CHANGELOG_URL, icon: ScrollText },
      { key: 'feedback', url: FEEDBACK_URL, icon: MessageSquareWarning },
   ];

   return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
         <DropdownMenuTrigger asChild>
            <button
               type="button"
               aria-label={t('helpMenu')}
               title={t('help')}
               className={`size-[26px] ${shellIconButton}`}
            >
               <CircleHelp className="size-3.5" />
            </button>
         </DropdownMenuTrigger>
         <DropdownMenuContent side="top" align="start" className="min-w-56 rounded-lg">
            <DropdownMenuLabel>{t('help')}</DropdownMenuLabel>
            {links.map(({ key, url, icon: Icon }) =>
               url ? (
                  <DropdownMenuItem key={key} asChild>
                     <a href={url} target="_blank" rel="noreferrer noopener">
                        <Icon className="size-4" />
                        {t(key)}
                     </a>
                  </DropdownMenuItem>
               ) : (
                  // Listed but disabled: the deployment has not published this
                  // address, which is a different thing from the menu lacking
                  // the entry.
                  <DropdownMenuItem key={key} disabled>
                     <Icon className="size-4" />
                     {t(key)}
                  </DropdownMenuItem>
               )
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
               {version ? t('serverVersion', { version }) : t('serverVersionUnknown')}
            </DropdownMenuItem>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
