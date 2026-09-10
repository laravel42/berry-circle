import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importFromGitHub, parseGitHubSkillUrl, SkillImportError } from './github-import.ts';

test('tree and blob URLs resolve to owner, repo, ref and directory', () => {
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/pdf'), {
      owner: 'acme', repo: 'skills', ref: 'main', path: 'pdf',
   });
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/skills/blob/v2/pdf/SKILL.md'), {
      owner: 'acme', repo: 'skills', ref: 'v2', path: 'pdf',
   });
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/pdf-skill'), {
      owner: 'acme', repo: 'pdf-skill', ref: null, path: '',
   });
   assert.throws(() => parseGitHubSkillUrl('https://gitlab.com/a/b'), SkillImportError);
});

function fakeGitHub(tree: Record<string, string | string[]>): typeof fetch {
   return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname.replace(/^\/repos\/acme\/skills\/contents\/?/, ''));
      const entry = tree[path];
      if (entry === undefined) return new Response('{}', { status: 404 });
      if (Array.isArray(entry)) {
         return Response.json(
            entry.map((name) => ({
               name, path: path ? `${path}/${name}` : name,
               type: Array.isArray(tree[path ? `${path}/${name}` : name]) ? 'dir' : 'file',
            }))
         );
      }
      return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(entry).toString('base64') });
   }) as typeof fetch;
}

test('a directory with SKILL.md becomes a skill with its supporting files', async () => {
   const skill = await importFromGitHub(
      'https://github.com/acme/skills/tree/main/pdf',
      fakeGitHub({
         pdf: ['SKILL.md', 'scripts'],
         'pdf/SKILL.md': '---\nname: pdf-tools\ndescription: PDFs\n---\nUse it.\n',
         'pdf/scripts': ['run.sh'],
         'pdf/scripts/run.sh': 'echo hi',
      })
   );
   assert.equal(skill.name, 'pdf-tools');
   assert.equal(skill.description, 'PDFs');
   assert.equal(skill.content, 'Use it.\n');
   assert.deepEqual(skill.files, [{ path: 'scripts/run.sh', content: 'echo hi' }]);
   assert.equal(skill.sourceKind, 'github');
   assert.equal(skill.sourceRef, 'main');
});

test('a directory without SKILL.md is refused by name', async () => {
   await assert.rejects(
      importFromGitHub('https://github.com/acme/skills/tree/main/pdf', fakeGitHub({ pdf: ['README.md'], 'pdf/README.md': 'x' })),
      (error: unknown) => error instanceof SkillImportError && error.code === 'SKILL_MANIFEST_MISSING'
   );
});
