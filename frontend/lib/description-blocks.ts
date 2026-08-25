import type { ContentBlock } from '@/data/issue-details';

/**
 * Turn a stored description into the blocks the renderers expect.
 *
 * Descriptions are saved as plain text with light markdown — the editor is a
 * textarea, so what people type is what is stored. The overview renders blocks
 * and builds its outline from headings, so text has to become structure
 * somewhere; doing it here means the API keeps storing exactly what was typed
 * rather than a parsed shape that has to survive a round trip.
 *
 * Deliberately small. It recognises headings, bullets and paragraphs, and
 * leaves anything else as text — a fuller markdown parser would change how
 * existing descriptions render, which is not what a reader of an old project
 * expects to happen to it.
 */
export function descriptionToBlocks(text: string | undefined): ContentBlock[] {
   const source = (text ?? '').trim();
   if (!source) return [];

   const blocks: ContentBlock[] = [];
   let paragraph: string[] = [];
   let bullets: string[] = [];

   const flushParagraph = () => {
      if (paragraph.length === 0) return;
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
   };
   const flushBullets = () => {
      if (bullets.length === 0) return;
      blocks.push({ type: 'bullet-list', items: bullets });
      bullets = [];
   };
   const flush = () => {
      flushParagraph();
      flushBullets();
   };

   for (const raw of source.split('\n')) {
      const line = raw.trim();

      if (!line) {
         flush();
         continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
         flush();
         // The outline only distinguishes two levels, so deeper headings fold
         // into the second rather than disappearing from it.
         blocks.push({
            type: 'heading',
            text: heading[2].trim(),
            level: heading[1].length === 1 ? 1 : 2,
         });
         continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
         flushParagraph();
         bullets.push(bullet[1].trim());
         continue;
      }

      flushBullets();
      paragraph.push(line);
   }
   flush();
   return blocks;
}
