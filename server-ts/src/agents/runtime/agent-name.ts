/**
 * A model-safe agent name.
 *
 * Berry's names are free text — "Prototype Writer" — so they are normalised
 * rather than rejected: the name is a label the model sees, and refusing to
 * run an agent because its name has a space in it would be absurd.
 */
export function toAgentName(name: string): string {
   const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
   return normalized === '' ? 'agent' : normalized;
}
