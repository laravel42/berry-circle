import { Issue } from './issues';
import { User } from './users';

/* -------------------------------------------------------------------------- */
/*                         Rich content block model                           */
/* -------------------------------------------------------------------------- */

export type ContentBlock =
   | { type: 'heading'; text: string; level?: 1 | 2 }
   | { type: 'paragraph'; text: string }
   | { type: 'bullet-list'; items: string[] }
   | { type: 'numbered-list'; items: string[] }
   | { type: 'checklist'; items: { text: string; checked: boolean }[] }
   | { type: 'code'; language: string; code: string }
   | { type: 'image'; alt: string; caption?: string; aspect?: 'wide' | 'video' | 'square' }
   | { type: 'video'; title: string; duration?: string }
   | { type: 'quote'; text: string; author?: string }
   | { type: 'divider' }
   | { type: 'issue-ref'; identifier: string; note?: string };

export interface CommentReaction {
   emoji: string;
   count: number;
}

export type ActivityItem =
   | {
        kind: 'event';
        id: string;
        actor: User;
        event: string;
        text: string;
        timeAgo: string;
     }
   | {
        kind: 'comment';
        id: string;
        actor: User;
        timeAgo: string;
        body: ContentBlock[];
        reactions?: CommentReaction[];
     };

export interface PrLink {
   id: string;
   title: string;
   status: 'open' | 'merged' | 'draft';
}

export interface IssueDetail {
   identifier: string;
   description: ContentBlock[];
   activity: ActivityItem[];
   subIssueIds?: string[];
   relatedIds?: string[];
   blockedByIds?: string[];
   prLinks?: PrLink[];
   milestone?: string;
}

/* -------------------------------------------------------------------------- */
/*                    Portal root hook (DOM utility, not mock)                */
/* -------------------------------------------------------------------------- */

import { useEffect, useState } from 'react';

export function useDialogPortalRoot(node?: HTMLElement | null) {
   const [root, setRoot] = useState<Element | undefined>();
   useEffect(() => {
      setRoot(node ?? document.getElementById('dialog-portal-root') ?? document.body);
   }, [node]);
   return root;
}

/* -------------------------------------------------------------------------- */
/*                    Data access (populated at runtime)                      */
/* -------------------------------------------------------------------------- */

export function getIssueDetail(issue: Issue): IssueDetail {
   return {
      identifier: issue.identifier,
      description: [],
      activity: [],
   };
}
