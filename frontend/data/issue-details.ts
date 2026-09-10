import { Issue } from './issues';
import { User } from './users';
import type { ApiComment } from '@/lib/comments';

/* -------------------------------------------------------------------------- */
/*                         Rich content block model                           */
/* -------------------------------------------------------------------------- */

/**
 * Structured description content. Text supports lightweight inline
 * formatting: `code` and **bold** (parsed by the block renderer).
 */
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
        /** e.g. 'created' | 'status' | 'label' | 'priority' | 'cycle' | 'blocked' | 'unblocked' | 'related' | 'pr' */
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
        /** The server comment, when the item came from the API; enables actions. */
        comment?: ApiComment;
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
/*                                   Access                                   */
/* -------------------------------------------------------------------------- */

/**
 * Detail for an issue. The Circle template shipped handcrafted and
 * deterministically-generated demo content here; that was stripped with the
 * rest of the mock data layer. Real descriptions, comments and activity
 * arrive from the gateway (see BERR-30), so until then every issue detail
 * boots empty.
 */
export function getIssueDetail(issue: Issue): IssueDetail {
   return {
      identifier: issue.identifier,
      description: [],
      activity: [],
   };
}
