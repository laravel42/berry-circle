import { inflateRawSync } from 'node:zlib';
import { MAX_BYTES, MAX_FILES, SkillImportError, toImported } from './github-import.ts';
import type { ImportedSkill } from './repository.ts';

/**
 * The central directory of a zip, read without a dependency.
 *
 * Only what a skill archive needs: stored (0) and deflate (8) entries, no
 * encryption, no zip64. Anything else is refused rather than half-read.
 */
export function readZip(bytes: Buffer): { path: string; content: Buffer }[] {
   const invalid = () => new SkillImportError('SKILL_ARCHIVE_INVALID', 'That is not a zip archive Berry can read.');
   let end = -1;
   for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
      if (bytes.readUInt32LE(i) === 0x06054b50) {
         end = i;
         break;
      }
   }
   if (end < 0) throw invalid();
   const count = bytes.readUInt16LE(end + 10);
   let cursor = bytes.readUInt32LE(end + 16);
   const entries: { path: string; content: Buffer }[] = [];
   let total = 0;
   for (let n = 0; n < count; n += 1) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
      const method = bytes.readUInt16LE(cursor + 10);
      const compressed = bytes.readUInt32LE(cursor + 20);
      const size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extra = bytes.readUInt16LE(cursor + 30);
      const comment = bytes.readUInt16LE(cursor + 32);
      const local = bytes.readUInt32LE(cursor + 42);
      const path = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      cursor += 46 + nameLength + extra + comment;
      if (path.endsWith('/')) continue;
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const body = bytes.subarray(start, start + compressed);
      // The declared size is attacker-controlled, so it is checked before any
      // inflate, and the inflate itself is capped: a 2 MiB zip bomb must not
      // expand into gigabytes of memory before the total check below runs.
      if (size > MAX_BYTES || total + size > MAX_BYTES) {
         throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
      }
      let content: Buffer | null = null;
      try {
         content = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : null;
      } catch {
         throw invalid();
      }
      if (!content || content.length !== size) throw invalid();
      total += size;
      if (entries.length >= MAX_FILES || total > MAX_BYTES) {
         throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
      }
      entries.push({ path, content });
   }
   return entries;
}

export function skillFromArchive(entries: { path: string; content: Buffer }[]): ImportedSkill {
   const text = entries.filter((e) => !e.content.includes(0) && !e.path.startsWith('__MACOSX/'));
   const tops = new Set(text.map((e) => e.path.split('/')[0]));
   const [only] = [...tops];
   const strip = tops.size === 1 && only !== undefined && !text.some((e) => e.path === only) ? `${only}/` : '';
   const files = text
      .map((e) => ({ path: e.path.slice(strip.length), content: e.content.toString('utf8') }))
      .filter((f) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f.path) && !f.path.split('/').includes('..'));
   return toImported(files, 'zip', null, null);
}
