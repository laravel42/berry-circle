/**
 * The names and sizes inside a zip, without unpacking it.
 *
 * A zip ends with a central directory listing every entry, which is enough to
 * answer the two questions the import dialog asks before it uploads anything:
 * is there a SKILL.md in here, and does it fit? Nothing is inflated — the
 * server does that, and it is the one that decides — so this stays a few
 * hundred bytes of reading rather than a decompression library.
 */

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** The end record is 22 bytes plus a comment of at most 64 KiB. */
const MAX_END_SCAN = 22 + 0xffff;

export interface ZipEntry {
   path: string;
   /** Uncompressed size, which is what the skill will actually hold. */
   bytes: number;
}

export class ZipUnreadable extends Error {}

export function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
   const view = new DataView(buffer);
   const start = findEndRecord(view);
   const count = view.getUint16(start + 10, true);
   let offset = view.getUint32(start + 16, true);
   const decoder = new TextDecoder();
   const entries: ZipEntry[] = [];
   for (let index = 0; index < count; index += 1) {
      if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== DIRECTORY_ENTRY) {
         throw new ZipUnreadable('the zip directory ends sooner than it claims');
      }
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const path = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
      // A directory entry is a name ending in a slash; it holds nothing.
      if (!path.endsWith('/')) entries.push({ path, bytes: size });
      offset += 46 + nameLength + extraLength + commentLength;
   }
   return entries;
}

function findEndRecord(view: DataView): number {
   const from = Math.max(0, view.byteLength - MAX_END_SCAN);
   for (let at = view.byteLength - 22; at >= from; at -= 1) {
      if (view.getUint32(at, true) === END_OF_DIRECTORY) return at;
   }
   throw new ZipUnreadable('this file does not end like a zip');
}

/**
 * What the skill would hold: paths relative to the archive's single top folder,
 * as the server's own import does when everything sits under one directory.
 */
export function skillPaths(entries: ZipEntry[]): ZipEntry[] {
   const roots = new Set(entries.map((entry) => entry.path.split('/')[0] ?? ''));
   const nested = roots.size === 1 && entries.every((entry) => entry.path.includes('/'));
   if (!nested) return entries;
   const prefix = `${[...roots][0] ?? ''}/`;
   return entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}
