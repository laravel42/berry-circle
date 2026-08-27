/**
 * Field validators, ported from
 * server/internal/handlers/identity/validation.go.
 *
 * These decide what reaches the database, so each one matches Go's rule rather
 * than a reasonable equivalent: while both servers answer the same frontend, a
 * value one accepts and the other refuses is a bug that appears only for
 * whichever prefix has already moved.
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
export const ONBOARDING_STEPS = ['welcome', 'aboutYou', 'workspace', 'complete'] as const;
export const ONBOARDING_ANSWER_KEYS = ['role', 'teamSize', 'goal', 'source'] as const;
