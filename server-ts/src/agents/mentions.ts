/**
 * Mentions are explicit tokens the composer writes, never guessed from text.
 *
 * A bare "@Coder" could be a name, a handle or an email fragment; guessing
 * would start runs nobody asked for. The picker inserts
 * `@[Name](agent:<uuid>)` or `@[Name](squad:<uuid>)`, which is unambiguous and
 * survives a rename.
 */
const TOKEN =
   /@\[[^\]\n]{1,100}\]\((agent|squad):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

export function parseMentions(body: string): { agents: string[]; squads: string[] } {
   const agents = new Set<string>();
   const squads = new Set<string>();
   for (const match of body.matchAll(TOKEN)) {
      const id = (match[2] ?? '').toLowerCase();
      if (match[1] === 'agent') agents.add(id);
      else squads.add(id);
   }
   return { agents: [...agents], squads: [...squads] };
}
