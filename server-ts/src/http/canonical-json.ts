/**
 * The canonical serialization idempotency fingerprints are hashed over.
 *
 * It is Go's `json.Marshal` of a decoded `any`, reproduced byte for byte,
 * because fingerprints computed that way are already stored and a request that
 * hashed differently would stop matching its own replay. Four things differ
 * from `JSON.stringify`, and each one changes the hash:
 *
 *   - Go marshals a map with its keys sorted; JavaScript preserves insertion
 *     order, so `{"b":2,"a":1}` and `{"a":1,"b":2}` would hash differently.
 *   - Go's decoder is given UseNumber, so a number keeps the literal text it
 *     arrived as: `1.0` stays `1.0` where JavaScript would write `1`.
 *   - Go escapes `<`, `>` and `&` by default, for callers who embed JSON in
 *     HTML.
 *   - Go has no short escape for backspace or form feed and writes them as
 *     `` and ``, and it escapes U+2028/U+2029, which JavaScript
 *     leaves literal.
 */

/** A number that must be written back exactly as it was read. */
class RawNumber {
   readonly source: string;
   constructor(source: string) {
      this.source = source;
   }
}

/**
 * Parses while keeping each number's original text.
 *
 * The reviver's third argument carries the source span for primitives, which
 * is the only way to tell `1.0` from `1` after parsing.
 */
export function parseWithRawNumbers(text: string): unknown {
   return JSON.parse(text, function (_key, value: unknown, context?: { source?: string }) {
      if (typeof value === 'number' && context?.source !== undefined) {
         return new RawNumber(context.source);
      }
      return value;
   });
}

/**
 * Go's `json.Marshal` of a *struct*, which is not the same as of a map.
 *
 * A struct marshals in field-declaration order and is never sorted, so this
 * writes properties in insertion order. Everything else — the escaping, the
 * treatment of null — is shared with `canonicalJSON`.
 *
 * The distinction matters wherever a hash is taken over a struct: sorting one
 * would change the value.
 */
export function structJSON(value: unknown): string {
   if (value === null || value === undefined) return 'null';
   if (typeof value === 'string') return quote(value);
   if (typeof value === 'boolean') return value ? 'true' : 'false';
   if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
   if (Array.isArray(value)) return `[${value.map(structJSON).join(',')}]`;
   return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${quote(key)}:${structJSON(entry)}`)
      .join(',')}}`;
}

export function canonicalJSON(value: unknown): string {
   if (value === null) return 'null';
   if (value instanceof RawNumber) return value.source;
   switch (typeof value) {
      case 'boolean':
         return value ? 'true' : 'false';
      case 'number':
         // Only reached for values not produced by parseWithRawNumbers.
         return Number.isFinite(value) ? String(value) : 'null';
      case 'string':
         return quote(value);
      default:
         break;
   }
   if (Array.isArray(value)) {
      return `[${value.map(canonicalJSON).join(',')}]`;
   }
   const entries = Object.entries(value as Record<string, unknown>);
   // Go sorts map keys by their UTF-8 bytes; for JSON keys that is the same
   // order as comparing code points.
   entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
   return `{${entries.map(([key, entry]) => `${quote(key)}:${canonicalJSON(entry)}`).join(',')}}`;
}

const SHORT: Record<string, string> = {
   '\\': '\\\\',
   '"': '\\"',
   '\n': '\\n',
   '\r': '\\r',
   '\t': '\\t',
};

function quote(value: string): string {
   let out = '"';
   for (const character of value) {
      const code = character.codePointAt(0)!;
      const short = SHORT[character];
      if (short !== undefined) {
         out += short;
      } else if (code < 0x20 || character === '<' || character === '>' || character === '&') {
         // No short escape for backspace or form feed in Go, and the three
         // HTML-significant characters are escaped by default.
         out += `\\u${code.toString(16).padStart(4, '0')}`;
      } else if (code === 0x2028 || code === 0x2029) {
         out += `\\u${code.toString(16)}`;
      } else {
         out += character;
      }
   }
   return `${out}"`;
}
