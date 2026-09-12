'use client';

import { format, parseISO } from 'date-fns';
import { KeyRound, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import {
   API_SCOPES,
   createToken,
   loadTokens,
   revokeToken,
   type PersonalToken,
} from '@/lib/settings';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/** The expiry choices, as the select's values. `never` carries no expiry. */
const EXPIRIES = ['30', '90', '365', 'never'] as const;
type Expiry = (typeof EXPIRIES)[number];

const EXPIRY_LABEL: Record<Expiry, 'expiry30' | 'expiry90' | 'expiry365' | 'expiryNever'> = {
   '30': 'expiry30',
   '90': 'expiry90',
   '365': 'expiry365',
   'never': 'expiryNever',
};

/**
 * Personal API keys.
 *
 * They used to share a page with the session list, where creating one was a
 * name and nothing else: no expiry, and the secret shown beside a button that
 * dismissed it in one click. A key with no expiry is the default that ages
 * worst, so the choice is offered and ninety days is what it opens on.
 *
 * The secret appears exactly once — the server keeps a hash — so the dialog
 * that shows it cannot be dismissed by clicking away or pressing Escape, and
 * "Done" waits until someone says they have stored it. That is a deliberate
 * piece of friction: every other way out of that dialog loses the key and
 * gives no sign that anything was lost.
 */
export default function ApiTokens() {
   const t = useTranslations('workspaceAdmin.tokens');
   const tokens = useSettingsResource<PersonalToken[]>(loadTokens);

   const [name, setName] = useState('');
   const [expiry, setExpiry] = useState<Expiry>('90');
   /** Public API scopes for the next key; null means full access. */
   const [scopes, setScopes] = useState<string[] | null>(null);
   const [creating, setCreating] = useState(false);

   /** Shown once. The server keeps a hash, so this is the only time it exists. */
   const [secret, setSecret] = useState<string | null>(null);
   const [stored, setStored] = useState(false);
   const [revoking, setRevoking] = useState<PersonalToken | null>(null);

   const create = async () => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      setCreating(true);
      try {
         const { secret: issued, record } = await createToken(
            trimmed,
            scopes,
            expiry === 'never' ? null : Number(expiry)
         );
         tokens.set([record, ...(tokens.value ?? [])]);
         setName('');
         setScopes(null);
         setExpiry('90');
         if (issued) {
            setStored(false);
            setSecret(issued);
         } else {
            // An idempotent replay: the key exists, but its secret is gone for
            // good, so say that rather than showing an empty box.
            toast.error(t('replayed'));
         }
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('createFailed'));
      } finally {
         setCreating(false);
      }
   };

   const confirmRevoke = async () => {
      if (!revoking) return;
      const rest = (tokens.value ?? []).filter((entry) => entry.id !== revoking.id);
      const ok = await tokens.mutate(rest, () => revokeToken(revoking.id));
      if (ok) setRevoking(null);
   };

   const when = (iso: string) => format(parseISO(iso), 'd MMM yyyy');

   const describe = (token: PersonalToken) => {
      const expired = token.expiresAt !== null && new Date(token.expiresAt) < new Date();
      return [
         `${token.prefix}…`,
         t('created', { when: when(token.createdAt) }),
         token.lastUsedAt ? t('lastUsed', { when: when(token.lastUsedAt) }) : t('neverUsed'),
         token.expiresAt === null
            ? t('neverExpires')
            : expired
              ? t('expired')
              : t('expires', { when: when(token.expiresAt) }),
         token.scopes ? token.scopes.join(', ') : t('scopesFull'),
      ].join(' · ');
   };

   return (
      <SettingsShell title={t('title')} description={t('subtitle')}>
         <SettingsSection title={t('listTitle')} description={tokens.error ?? undefined}>
            <SettingsCard>
               {tokens.loading ? <SettingsRow title={t('loading')} /> : null}
               {!tokens.loading && (tokens.value ?? []).length === 0 ? (
                  <SettingsRow title={t('empty')} />
               ) : null}
               {(tokens.value ?? []).map((token) => (
                  <SettingsRow
                     key={token.id}
                     icon={<KeyRound className="size-4" />}
                     title={token.name}
                     description={describe(token)}
                     trailing={
                        <Button
                           size="xs"
                           variant="ghost"
                           className="text-status-danger hover:text-status-danger"
                           disabled={tokens.saving}
                           onClick={() => setRevoking(token)}
                        >
                           {t('revoke')}
                        </Button>
                     }
                  />
               ))}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('newTitle')} description={t('newDescription')}>
            <SettingsCard>
               <SettingsRow
                  title={t('name')}
                  trailing={
                     <Input
                        value={name}
                        aria-label={t('name')}
                        placeholder={t('namePlaceholder')}
                        className="h-8 w-52"
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                           if (event.key === 'Enter') void create();
                        }}
                     />
                  }
               />
               <SettingsRow
                  title={t('expiry')}
                  description={t('expiryDescription')}
                  trailing={
                     <Select value={expiry} onValueChange={(next) => setExpiry(next as Expiry)}>
                        <SelectTrigger className="h-8 w-44" aria-label={t('expiry')}>
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           {EXPIRIES.map((option) => (
                              <SelectItem key={option} value={option}>
                                 {t(EXPIRY_LABEL[option])}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  }
               />
               <SettingsRow
                  title={t('scopes')}
                  description={scopes === null ? t('scopesFullHint') : t('scopesLimitedHint')}
                  trailing={
                     <span className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-1.5">
                           <Checkbox
                              checked={scopes === null}
                              onCheckedChange={(checked) => setScopes(checked === true ? null : [])}
                           />
                           {t('scopeFull')}
                        </label>
                        {API_SCOPES.map((scope) => (
                           <label key={scope} className="flex items-center gap-1.5">
                              <Checkbox
                                 disabled={scopes === null}
                                 checked={scopes?.includes(scope) ?? false}
                                 onCheckedChange={(checked) =>
                                    setScopes((current) => {
                                       const list = (current ?? []).filter(
                                          (entry) => entry !== scope
                                       );
                                       return checked === true ? [...list, scope] : list;
                                    })
                                 }
                              />
                              {scope}
                           </label>
                        ))}
                     </span>
                  }
               />
               <SettingsRow
                  title=""
                  trailing={
                     <Button
                        size="xs"
                        disabled={creating || name.trim() === ''}
                        onClick={() => void create()}
                     >
                        {creating ? (
                           <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                           t('create')
                        )}
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         {/* The only copy of the key. Clicking away would lose it silently, so
             this dialog closes one way: by saying it has been stored. */}
         <Dialog open={secret !== null} onOpenChange={() => undefined}>
            <DialogContent
               onEscapeKeyDown={(event) => event.preventDefault()}
               onInteractOutside={(event) => event.preventDefault()}
            >
               <DialogHeader>
                  <DialogTitle>{t('secretTitle')}</DialogTitle>
                  <DialogDescription>{t('secretBody')}</DialogDescription>
               </DialogHeader>
               <code className="block rounded-md border bg-container px-3 py-2 font-mono break-all text-muted-foreground">
                  {secret}
               </code>
               <label className="flex items-center gap-2">
                  <Checkbox
                     checked={stored}
                     onCheckedChange={(checked) => setStored(checked === true)}
                  />
                  {t('stored')}
               </label>
               <DialogFooter>
                  <Button
                     variant="secondary"
                     onClick={() => {
                        void navigator.clipboard?.writeText(secret ?? '');
                        toast.success(t('copied'));
                     }}
                  >
                     {t('copy')}
                  </Button>
                  <Button
                     disabled={!stored}
                     onClick={() => {
                        setSecret(null);
                        setStored(false);
                     }}
                  >
                     {t('done')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('revokeTitle')}</DialogTitle>
                  <DialogDescription>
                     {t('revokeBody', { name: revoking?.name ?? '' })}
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="secondary" onClick={() => setRevoking(null)}>
                     {t('cancel')}
                  </Button>
                  <Button
                     variant="destructive"
                     disabled={tokens.saving}
                     onClick={() => void confirmRevoke()}
                  >
                     {t('revokeAction')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </SettingsShell>
   );
}
