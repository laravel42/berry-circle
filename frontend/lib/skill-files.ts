/**
 * The rules a skill's files follow, kept away from the screens that enforce them.
 *
 * The server has the same rules and is the authority (`skill_files` carries the
 * path CHECK, and the import refuses an archive with no main file). These exist
 * so a person is told before they wait for a round trip, and so the import
 * preview can say what will happen rather than guessing.
 */

/** The skill's own instructions. It is the skill, so it is never a file in the tree. */
export const MAIN_FILE = 'SKILL.md';

/** What the server accepts: `files` is capped at 100, each at 256 KiB. */
export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 256 * 1024;
/** The zip route refuses a body larger than this, so a folder is held to it too. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export type PathProblem =
   'empty' | 'absolute' | 'dotdot' | 'reserved' | 'duplicate' | 'clash' | 'shape';

/**
 * Why `path` cannot join `existing`, or null when it can.
 *
 * "Clash" is the case a flat list hides: a tree cannot hold both a file at
 * `docs` and a file at `docs/setup.md`, because one of them has to be a folder.
 */
export function pathProblem(rawPath: string, existing: readonly string[]): PathProblem | null {
   const path = rawPath.trim();
   if (path === '') return 'empty';
   if (path.startsWith('/')) return 'absolute';
   const segments = path.split('/');
   if (segments.includes('..') || segments.includes('.')) return 'dotdot';
   if (path.toLowerCase() === MAIN_FILE.toLowerCase()) return 'reserved';
   if (segments.some((segment) => !SEGMENT.test(segment))) return 'shape';
   if (existing.includes(path)) return 'duplicate';
   for (const other of existing) {
      if (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) return 'clash';
   }
   return null;
}

export interface Frontmatter {
   name: string | null;
   description: string | null;
   /** Everything after the frontmatter block; the instructions themselves. */
   body: string;
}

/**
 * Reads a leading `---` block, the way a SKILL.md carries its name and
 * description. Only the two keys Berry shows are read; anything else in the
 * block is left where it is, because Berry did not put it there.
 */
export function readFrontmatter(content: string): Frontmatter {
   const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
   if (!match) return { name: null, description: null, body: content };
   const fields = new Map<string, string>();
   for (const line of (match[1] ?? '').split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      fields.set(line.slice(0, at).trim().toLowerCase(), unquote(line.slice(at + 1).trim()));
   }
   return {
      name: fields.get('name') ?? null,
      description: fields.get('description') ?? null,
      body: content.slice(match[0].length),
   };
}

function unquote(value: string): string {
   const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
   return quoted ? (quoted[2] ?? '') : value;
}

/** A value that would break the block if it were written bare. */
function quoteIfNeeded(value: string): string {
   return /[:#]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Writes `name` and `description` back into the frontmatter, keeping any other
 * keys and the body. This is what makes the overview fields and the SKILL.md
 * one thing rather than two that drift.
 */
export function writeFrontmatter(
   content: string,
   values: { name: string; description: string }
): string {
   const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
   const kept: string[] = [];
   if (match) {
      for (const line of (match[1] ?? '').split(/\r?\n/)) {
         const key = line
            .slice(0, Math.max(0, line.indexOf(':')))
            .trim()
            .toLowerCase();
         if (key !== 'name' && key !== 'description' && line.trim() !== '') kept.push(line);
      }
   }
   const body = match ? content.slice(match[0].length) : content;
   const block = [
      `name: ${quoteIfNeeded(values.name)}`,
      `description: ${quoteIfNeeded(values.description)}`,
      ...kept,
   ];
   return `---\n${block.join('\n')}\n---\n${body}`;
}

export interface CandidateFile {
   path: string;
   content: string;
   bytes: number;
}

export type ImportProblem =
   | { kind: 'noMainFile' }
   | { kind: 'tooManyFiles'; count: number }
   | { kind: 'tooLarge'; bytes: number }
   | { kind: 'fileTooLarge'; path: string };

/**
 * Whether a chosen folder can become a skill: it must carry the main file, and
 * it must fit in what the server will take. Checked here so the preview can
 * show what would be imported instead of a failed request.
 */
export function inspectCandidate(files: CandidateFile[]): ImportProblem | null {
   const hasMain = files.some((file) => file.path === MAIN_FILE);
   if (!hasMain) return { kind: 'noMainFile' };
   const extra = files.filter((file) => file.path !== MAIN_FILE);
   if (extra.length > MAX_FILES) return { kind: 'tooManyFiles', count: extra.length };
   const total = files.reduce((sum, file) => sum + file.bytes, 0);
   if (total > MAX_TOTAL_BYTES) return { kind: 'tooLarge', bytes: total };
   const big = files.find((file) => file.bytes > MAX_FILE_BYTES);
   if (big) return { kind: 'fileTooLarge', path: big.path };
   return null;
}

/**
 * The path a chosen folder's file takes inside the skill: a picker reports
 * `my-skill/scripts/run.sh`, and the skill holds `scripts/run.sh`.
 */
export function stripLeadingFolder(paths: string[]): Map<string, string> {
   const roots = new Set(paths.map((path) => path.split('/')[0] ?? ''));
   const single = roots.size === 1 && paths.every((path) => path.includes('/'));
   const stripped = new Map<string, string>();
   for (const path of paths) {
      stripped.set(path, single ? path.slice((path.split('/')[0] ?? '').length + 1) : path);
   }
   return stripped;
}

export function formatBytes(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TreeNode {
   name: string;
   path: string;
   children: TreeNode[];
   /** A folder has no file of its own. */
   isFile: boolean;
}

/** The flat paths a skill stores, as the folders a person sees. */
export function buildTree(paths: readonly string[]): TreeNode[] {
   const roots: TreeNode[] = [];
   for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
      let level = roots;
      const segments = path.split('/');
      segments.forEach((segment, index) => {
         const isFile = index === segments.length - 1;
         const soFar = segments.slice(0, index + 1).join('/');
         let node = level.find((entry) => entry.name === segment && entry.isFile === isFile);
         if (!node) {
            node = { name: segment, path: soFar, children: [], isFile };
            level.push(node);
         }
         level = node.children;
      });
   }
   return roots;
}
