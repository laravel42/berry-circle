import { parseSkillMarkdown } from './frontmatter.ts';
import type { ImportedSkill, SkillFile } from './repository.ts';

export type SkillImportCode =
   | 'SKILL_URL_INVALID'
   | 'SKILL_MANIFEST_MISSING'
   | 'SKILL_TOO_LARGE'
   | 'SKILL_SOURCE_UNAVAILABLE'
   | 'SKILL_ARCHIVE_INVALID';

export class SkillImportError extends Error {
   override readonly name = 'SkillImportError';
   readonly code: SkillImportCode;
   constructor(code: SkillImportCode, message: string) {
      super(message);
      this.code = code;
   }
}

export interface SkillImporter {
   fromGitHub(url: string): Promise<ImportedSkill>;
}

export const MAX_FILES = 100;
export const MAX_BYTES = 1 << 20;

export function parseGitHubSkillUrl(raw: string): { owner: string; repo: string; ref: string | null; path: string } {
   let url: URL;
   try {
      url = new URL(raw);
   } catch {
      throw new SkillImportError('SKILL_URL_INVALID', 'That is not a URL.');
   }
   if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      throw new SkillImportError('SKILL_URL_INVALID', 'Skills import from github.com URLs only.');
   }
   const parts = url.pathname.split('/').filter(Boolean);
   const [owner, repo, mode, ref, ...rest] = parts;
   if (!owner || !repo) throw new SkillImportError('SKILL_URL_INVALID', 'The URL names no repository.');
   if (mode === undefined) return { owner, repo: repo.replace(/\.git$/, ''), ref: null, path: '' };
   if ((mode !== 'tree' && mode !== 'blob') || !ref) {
      throw new SkillImportError('SKILL_URL_INVALID', 'Use a repository, tree or blob URL.');
   }
   const path = rest.at(-1) === 'SKILL.md' ? rest.slice(0, -1) : rest;
   return { owner, repo, ref, path: path.join('/') };
}

export async function importFromGitHub(url: string, fetchImpl: typeof fetch = fetch): Promise<ImportedSkill> {
   const target = parseGitHubSkillUrl(url);
   const files: SkillFile[] = [];
   let total = 0;

   const get = async (path: string): Promise<unknown> => {
      const endpoint = new URL(`https://api.github.com/repos/${target.owner}/${target.repo}/contents/${path}`);
      if (target.ref) endpoint.searchParams.set('ref', target.ref);
      const response = await fetchImpl(endpoint, { headers: { accept: 'application/vnd.github+json' } });
      if (response.status === 404) throw new SkillImportError('SKILL_MANIFEST_MISSING', 'Nothing at that path.');
      if (!response.ok) throw new SkillImportError('SKILL_SOURCE_UNAVAILABLE', `GitHub answered ${response.status}.`);
      return response.json();
   };

   const walk = async (dir: string): Promise<void> => {
      const listing = await get(dir);
      if (!Array.isArray(listing)) throw new SkillImportError('SKILL_URL_INVALID', 'The URL does not name a directory.');
      for (const entry of listing as { name: string; path: string; type: string }[]) {
         if (entry.type === 'dir') {
            await walk(entry.path);
            continue;
         }
         if (entry.type !== 'file') continue;
         const file = (await get(entry.path)) as { content?: string; encoding?: string };
         const bytes = Buffer.from(file.content ?? '', file.encoding === 'base64' ? 'base64' : 'utf8');
         if (bytes.includes(0)) continue; // binary: a skill is text
         total += bytes.length;
         if (files.length >= MAX_FILES || total > MAX_BYTES) {
            throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
         }
         const relative = target.path ? entry.path.slice(target.path.length + 1) : entry.path;
         files.push({ path: relative, content: bytes.toString('utf8') });
      }
   };

   await walk(target.path);
   return toImported(files, 'github', url, target.ref);
}

/** Shared by the zip path: SKILL.md becomes the skill, everything else its files. */
export function toImported(
   files: SkillFile[],
   kind: 'github' | 'zip',
   sourceUrl: string | null,
   sourceRef: string | null
): ImportedSkill {
   const manifest = files.find((f) => f.path === 'SKILL.md');
   if (!manifest) throw new SkillImportError('SKILL_MANIFEST_MISSING', 'A skill needs a SKILL.md at its root.');
   const parsed = parseSkillMarkdown(manifest.content);
   const fallback = (sourceUrl ?? 'skill').split('/').filter(Boolean).at(-1) ?? 'skill';
   const name = (parsed.name ?? fallback).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
   return {
      name,
      description: (parsed.description ?? '').slice(0, 1024),
      content: parsed.body,
      labels: [],
      files: files.filter((f) => f.path !== 'SKILL.md').sort((a, b) => a.path.localeCompare(b.path)),
      sourceKind: kind,
      sourceUrl,
      sourceRef,
   };
}
