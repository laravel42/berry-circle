import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Enabled skills, laid out in the task workspace.
 *
 * Runs inside the container, so it imports nothing from outside
 * `agents/runtime/`. One directory per skill under `.claude/skills/`, with a
 * SKILL.md whose frontmatter names it, so tools that discover skills by that
 * convention find them, and the agent's instructions can point there.
 */

/** Structurally A's `SkillRef`: the server already rendered SKILL.md into `files`. */
export interface EnvelopeSkillLike {
   name: string;
   files: { path: string; content: string }[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function skillFileTree(skills: EnvelopeSkillLike[]): { path: string; content: string }[] {
   const out: { path: string; content: string }[] = [];
   for (const skill of skills) {
      if (!NAME.test(skill.name)) {
         throw new Error(`skill name ${JSON.stringify(skill.name)} is not a directory name`);
      }
      if (!skill.files.some((file) => file.path === 'SKILL.md')) {
         throw new Error(`skill ${JSON.stringify(skill.name)} has no SKILL.md`);
      }
      const base = `.claude/skills/${skill.name}`;
      for (const file of skill.files) {
         const segments = file.path.split('/');
         if (!PATH.test(file.path) || segments.includes('..') || segments.includes('.')) {
            throw new Error(`skill file ${JSON.stringify(file.path)} would leave its directory`);
         }
         out.push({ path: `${base}/${file.path}`, content: file.content });
      }
   }
   return out;
}

export async function writeSkills(root: string, skills: EnvelopeSkillLike[]): Promise<string[]> {
   const base = resolve(root);
   const written: string[] = [];
   for (const file of skillFileTree(skills)) {
      const target = resolve(base, file.path);
      // Belt and braces over the patterns: resolved, it must still be inside root.
      if (!target.startsWith(base + sep)) throw new Error(`refusing to write outside ${base}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      written.push(file.path);
   }
   return written;
}
