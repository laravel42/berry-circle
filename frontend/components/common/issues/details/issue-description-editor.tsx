'use client';

import { useIssuesStore } from '@/store/issues-store';
import { DescriptionTextarea } from '@/components/common/editor/description-textarea';

interface IssueDescriptionEditorProps {
   issueId: string;
   description: string;
}

/**
 * Issue description editor.
 *
 * The field hands back its text when editing settles, so the debounce this
 * previously carried is gone: there is nothing to debounce when the write
 * happens once, on commit, rather than on every keystroke.
 */
export function IssueDescriptionEditor({ issueId, description }: IssueDescriptionEditorProps) {
   const updateIssueDescription = useIssuesStore((state) => state.updateIssueDescription);

   return (
      <div className="mt-3">
         <DescriptionTextarea
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
