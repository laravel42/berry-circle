import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkillMarkdown } from './frontmatter.ts';

test('frontmatter name and description are read, and the body is what follows', () => {
   const parsed = parseSkillMarkdown(
      '---\nname: pdf-tools\ndescription: "Work with PDFs"\n---\n# PDF\nUse pdftotext.\n'
   );
   assert.equal(parsed.name, 'pdf-tools');
   assert.equal(parsed.description, 'Work with PDFs');
   assert.equal(parsed.body, '# PDF\nUse pdftotext.\n');
});

test('a file with no frontmatter is all body', () => {
   const parsed = parseSkillMarkdown('# Just text\n');
   assert.equal(parsed.name, null);
   assert.equal(parsed.description, null);
   assert.equal(parsed.body, '# Just text\n');
});

test('an unterminated frontmatter block is treated as body, not half-parsed', () => {
   const parsed = parseSkillMarkdown('---\nname: x\nno end');
   assert.equal(parsed.name, null);
   assert.equal(parsed.body, '---\nname: x\nno end');
});
