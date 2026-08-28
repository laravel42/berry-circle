/**
 * Docker's multiplexed stream format.
 *
 * An exec started without a TTY does not return raw bytes: it returns frames,
 * each prefixed with an eight-byte header that says which stream the payload
 * belongs to and how long it is.
 *
 *   byte 0     stream: 0 stdin, 1 stdout, 2 stderr
 *   bytes 1-3  zero
 *   bytes 4-7  payload length, big-endian uint32
 *
 * This is a better fit for Berry's protocol than it first looks: stdout and
 * stderr arrive already separated, which is exactly the distinction a run log
 * has to preserve, and no heuristic is involved in telling them apart.
 *
 * The parser is a class rather than a generator because chunk boundaries fall
 * wherever the socket decides — mid-header as easily as mid-payload — and the
 * remainder has to survive between reads.
 */

export type StreamKind = 'stdout' | 'stderr';

export interface Frame {
   kind: StreamKind;
   data: string;
}

const HEADER_BYTES = 8;

/**
 * Guards against a corrupt header claiming a gigabyte.
 *
 * Docker itself writes frames far below this; a length above it means the
 * stream is not what we think it is, and allocating for it is how a bad read
 * becomes an out-of-memory kill.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class Demultiplexer {
   #buffer: Buffer = Buffer.alloc(0);
   // Held across frames: a multi-byte character can be split by the payload
   // boundary as easily as by the socket, and decoding each frame in isolation
   // would turn one character into two replacement marks.
   readonly #decoders: Record<StreamKind, TextDecoder> = {
      stdout: new TextDecoder('utf-8'),
      stderr: new TextDecoder('utf-8'),
   };

   /** Consumes a chunk and returns whatever complete frames it completed. */
   push(chunk: Buffer): Frame[] {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      const frames: Frame[] = [];

      for (;;) {
         if (this.#buffer.length < HEADER_BYTES) break;
         const kind = kindOf(this.#buffer[0]);
         const size = this.#buffer.readUInt32BE(4);

         if (size > MAX_FRAME_BYTES) {
            throw new Error(`docker stream declared an implausible frame of ${size} bytes`);
         }
         if (this.#buffer.length < HEADER_BYTES + size) break;

         const payload = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + size);
         this.#buffer = this.#buffer.subarray(HEADER_BYTES + size);

         // stdin frames never appear on an exec output stream; if one did, it
         // is not ours to interpret.
         if (kind !== null) {
            const data = this.#decoders[kind].decode(payload, { stream: true });
            if (data !== '') frames.push({ kind, data });
         }
      }
      return frames;
   }

   /** Flushes anything the decoders are still holding. Call once at end of stream. */
   end(): Frame[] {
      const frames: Frame[] = [];
      for (const kind of ['stdout', 'stderr'] as const) {
         const data = this.#decoders[kind].decode();
         if (data !== '') frames.push({ kind, data });
      }
      return frames;
   }

   /** Bytes held back waiting for the rest of a frame. Zero at a clean end. */
   get pending(): number {
      return this.#buffer.length;
   }
}

function kindOf(byte: number | undefined): StreamKind | null {
   if (byte === 1) return 'stdout';
   if (byte === 2) return 'stderr';
   return null;
}
