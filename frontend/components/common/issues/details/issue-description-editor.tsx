'use client';

import { MarkdownPreviewTextarea } from '@/components/common/editor/markdown-preview-textarea';
import { useIssuesStore } from '@/store/issues-store';
import { useEffect, useState } from 'react';

interface IssueDescriptionEditorProps {
   issueId: string;
   description: string;
}

export function IssueDescriptionEditor({ issueId, description }: IssueDescriptionEditorProps) {
   const updateIssueDescription = useIssuesStore((state) => state.updateIssueDescription);
   const [draft, setDraft] = useState(description);

   useEffect(() => {
      setDraft(description);
   }, [description]);

   useEffect(() => {
      if (draft === description) return;
      const timer = window.setTimeout(() => {
         updateIssueDescription(issueId, draft);
      }, 500);
      return () => window.clearTimeout(timer);
   }, [draft, description, issueId, updateIssueDescription]);

   const persist = () => {
      if (draft !== description) {
         updateIssueDescription(issueId, draft);
      }
   };

   return (
      <div className="mt-3">
         <MarkdownPreviewTextarea
            value={draft}
            onChange={setDraft}
            onBlur={persist}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder="Add description…"
            rows={4}
         />
      </div>
   );
}
