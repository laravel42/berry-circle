/**
 * The `Co-authored-by` trailer on an agent's commit.
 *
 * Agent commits are authored as Berry itself, so GitHub shows no person on
 * them. The trailer puts the person who asked for the work beside it, which is
 * how GitHub attributes a commit to more than one author.
 *
 * Pure on purpose: the delivery path is moving into the runtime container, and
 * the decision travels with it as a function rather than as a query.
 */

export interface TrailerSettings {
   /** The workspace's GitHub master switch. */
   enabled: boolean;
   /** The "Co-authored-by trailer on agent commits" toggle. */
   coAuthorTrailer: boolean;
}

export interface CommitAuthor {
   name: string | null;
   email: string | null;
}

/** An address with one `@`, a dot in the domain, and nothing that breaks a trailer. */
const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

/**
 * The trailer line, or null when there should be none.
 *
 * `.invalid` is the reserved top-level domain Berry gives its own system
 * identities (the agent commit author, the orchestrator's intake user).
 * Crediting one of those would put a name on the commit that belongs to nobody.
 */
export function coAuthorTrailer(
   settings: TrailerSettings | null,
   author: CommitAuthor | null
): string | null {
   if (!settings?.enabled || !settings.coAuthorTrailer || !author) return null;
   const email = (author.email ?? '').trim();
   if (!ADDRESS.test(email) || email.toLowerCase().endsWith('.invalid')) return null;
   // A trailer is one line of `Key: value`. Angle brackets would let a name
   // carry an address of its own, and a newline would start a trailer nobody
   // wrote; both are removed rather than escaped, since git has no escape.
   const name = (author.name ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
   return `Co-authored-by: ${name || email.split('@')[0]} <${email}>`;
}

/**
 * The message with the trailers added after a blank line.
 *
 * A trailer the message already carries is not added again, so a retried
 * delivery cannot stack a second copy.
 */
export function withTrailers(message: string, trailers: readonly string[]): string {
   const base = message.replace(/\s+$/, '');
   const present = new Set(base.split('\n').map((line) => line.trim()));
   const fresh = [...new Set(trailers)].filter((trailer) => !present.has(trailer.trim()));
   if (fresh.length === 0) return base;
   return `${base}\n\n${fresh.join('\n')}`;
}
