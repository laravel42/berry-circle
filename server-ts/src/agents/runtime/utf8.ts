/**
 * Cuts to a byte budget on a character boundary.
 *
 * Cutting mid-sequence would leave a replacement character at the end of every
 * truncated report, which readers take for corruption rather than a limit.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
   if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
   const buffer = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes));

   // Find where the last character starts, then keep it only if all of it is
   // here. Stripping trailing continuation bytes unconditionally would eat a
   // character that happened to end exactly on the boundary.
   let start = buffer.length - 1;
   while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1;
   if (start < 0) return '';

   const lead = buffer[start]!;
   const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
   const end = start + width > buffer.length ? start : buffer.length;
   return buffer.subarray(0, end).toString('utf8');
}
