'use client';

import { useIssuesStore } from '@/store/issues-store';
import { RichDescriptionEditor } from '@/components/common/editor/rich-description-editor';

interface IssueDescriptionEditorProps {
   issueId: string;
   description: string;
}

/**
 * Issue description editor.
 *
 * Plate owns the document and hands back markdown when editing settles, so the
 * debounce this previously carried is gone: there is nothing to debounce when
 * the write happens once, on commit, rather than on every keystroke.
 */
export function IssueDescriptionEditor({ issueId, description }: IssueDescriptionEditorProps) {
   const updateIssueDescription = useIssuesStore((state) => state.updateIssueDescription);

   return (
      <div className="mt-3">
         <RichDescriptionEditor
            value={description}
            onCommit={(markdown) => {
               if (markdown.trim() === description.trim()) return;
               updateIssueDescription(issueId, markdown);
            }}
            placeholder="Add description…"
            aria-label="Issue description"
         />
      </div>
   );
}
