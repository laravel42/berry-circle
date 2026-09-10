/**
 * Field validators.
 *
 * These decide what reaches the database, so each keeps the rule the API has
 * always enforced rather than a reasonable equivalent: a value that used to be
 * accepted and is now refused is a break for every client already sending it,
 * and one already stored is a row that can no longer be updated.
 */

/** Rune count, not UTF-16 length: Go bounds by runes and an emoji is one. */
export function boundedLength(value: string, minimum: number, maximum: number): boolean {
   const runes = [...value].length;
   return runes >= minimum && runes <= maximum;
}

/** An absolute HTTP(S) URL carrying no credentials. */
export function validAvatar(value: string): boolean {
   if (!boundedLength(value, 1, 2048)) return false;
   let parsed: URL;
   try {
      parsed = new URL(value);
   } catch {
      return false;
   }
   return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host !== '' &&
      parsed.username === '' &&
      parsed.password === ''
   );
}

/**
 * An IANA timezone the runtime can resolve.
 *
 * `Local` is accepted because Go's time.LoadLocation accepts it, and the two
 * servers have to agree while both are answering. It is a poor value to store
 * for a web client — it means nothing outside the process that wrote it — but
 * that is Go's behaviour today, and diverging here would be a contract change
 * smuggled in as a port.
 */
export function validTimezone(value: string): boolean {
   if (!boundedLength(value, 1, 100)) return false;
   if (value === 'Local' || value === 'UTC') return true;
   try {
      new Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
   } catch {
      return false;
   }
}

/**
 * An address Go's net/mail accepts, already lowercased.
 *
 * Go additionally requires `address.Address == value`, which rejects the
 * display-name forms mail.ParseAddress otherwise allows — `A <a@b.c>` parses
 * but is not equal to its own address. The pattern here admits no such form,
 * so that equality holds by construction.
 */
export function validEmail(value: string): boolean {
   if (value !== value.toLowerCase() || !boundedLength(value, 3, 320)) return false;
   const [local, domain, ...rest] = value.split('@');
   if (rest.length > 0 || !local || !domain) return false;
   // No dot is required in the domain: "a@b" has always been accepted, and
   // addresses like it are already stored.
   return (
      /^[^\s<>@,"'\\]+$/.test(local) &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)
   );
}

const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const ISSUE_PREFIX = /^[A-Z][A-Z0-9]{1,11}$/;

/** Bounds are bytes in Go (`len`), and the pattern is ASCII, so length agrees. */
export function validWorkspaceSlug(value: string): boolean {
   return value.length >= 2 && value.length <= 50 && WORKSPACE_SLUG.test(value);
}

export function validIssuePrefix(value: string): boolean {
   return ISSUE_PREFIX.test(value);
}

export const THEMES = ['system', 'light', 'dark'] as const;

/**
 * The interface languages the web app ships catalogues for. Stored verbatim,
 * because the frontend uses the value as the catalogue directory name.
 */
export const LOCALES = ['en', 'zh-Hans', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export function validLocale(value: string): value is Locale {
   return (LOCALES as readonly string[]).includes(value);
}
export const ONBOARDING_STEPS = ['welcome', 'aboutYou', 'workspace', 'complete'] as const;
export const ONBOARDING_ANSWER_KEYS = ['role', 'teamSize', 'goal', 'source'] as const;
