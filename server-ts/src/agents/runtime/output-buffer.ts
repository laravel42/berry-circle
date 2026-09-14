/**
 * How much streamed text is gathered before it becomes one ledger event.
 *
 * The previous runtime emitted whole sentences and Berry wrote one event per
 * chunk; the model emits tokens, and one transaction per token would mean thousands
 * of row-locked writes for one answer and a `run_events` table that is mostly
 * single words. Gathering to roughly a sentence keeps the stream live without
 * making the ledger a token log.
 *
 * The cap is the long-standing ceiling on a single published delta.
 */
export const OUTPUT_FLUSH_BYTES = 240;
export const OUTPUT_FLUSH_MS = 250;
export const MAX_DELTA_BYTES = 16 * 1024;


/**
 * Gathers streamed text into ledger-sized deltas.
 *
 * Time as well as size, because size alone stalls: an agent that stops
 * mid-sentence to think would leave its last words unwritten until it resumed,
 * and a reader watching the run would see it freeze. Whichever comes first
 * wins.
 */
export class OutputBuffer {
   private readonly write: (text: string) => Promise<void>;
   private pending = '';
   private since = 0;

   constructor(write: (text: string) => Promise<void>) {
      this.write = write;
   }

   async add(text: string): Promise<void> {
      if (this.pending === '') this.since = Date.now();
      this.pending += text;
      const size = Buffer.byteLength(this.pending, 'utf8');
      if (size >= OUTPUT_FLUSH_BYTES || Date.now() - this.since >= OUTPUT_FLUSH_MS) {
         await this.flush();
      }
   }

   async flush(): Promise<void> {
      if (this.pending === '') return;
      const text = this.pending;
      this.pending = '';
      // Split rather than truncated: a delta over the cap is still the
      // agent's words, and dropping the tail would lose them from the stream
      // while the summary still had them.
      for (const piece of splitUtf8(text, MAX_DELTA_BYTES)) await this.write(piece);
   }
}

/**
 * Cuts text into pieces of at most `maxBytes`, never mid-character.
 *
 * Ported from runadmission's splitUTF8, and for the same reason: a delta cut
 * mid-sequence reaches the browser as a replacement character in the middle of
 * a word.
 */
export function splitUtf8(value: string, maxBytes: number): string[] {
   if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value === '' ? [] : [value];

   const pieces: string[] = [];
   let piece = '';
   let size = 0;
   for (const character of value) {
      const width = Buffer.byteLength(character, 'utf8');
      if (size + width > maxBytes) {
         pieces.push(piece);
         piece = '';
         size = 0;
      }
      piece += character;
      size += width;
   }
   if (piece !== '') pieces.push(piece);
   return pieces;
}
