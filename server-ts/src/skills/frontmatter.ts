/**
 * A skill's `SKILL.md`: an optional `---` block of `key: value` lines, then
 * the instructions. Only `name` and `description` are read; anything else in
 * the block is kept in the body untouched rather than interpreted.
 */
export function parseSkillMarkdown(text: string): {
   name: string | null;
   description: string | null;
   body: string;
} {
   const normalized = text.replace(/\r\n/g, '\n');
   if (!normalized.startsWith('---\n')) return { name: null, description: null, body: normalized };
   const end = normalized.indexOf('\n---\n', 4);
   if (end < 0) return { name: null, description: null, body: normalized };

   const fields = new Map<string, string>();
   for (const line of normalized.slice(4, end).split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim().replace(/^["'](.*)["']$/, '$1');
      fields.set(key, value);
   }
   return {
      name: fields.get('name') || null,
      description: fields.get('description') || null,
      body: normalized.slice(end + 5),
   };
}
