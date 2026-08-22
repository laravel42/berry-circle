/**
 * Reviews feature (Linear-style PR reviews): list tabs ("For you" /
 * "Created"), and per-review Overview / Guide / Diff content. The demo
 * review seeds were removed with the mock data layer; reviews will arrive
 * from the gateway once review wiring lands.
 */

export type ReviewStatus = 'open' | 'merged' | 'closed';
export type ReviewList = 'for-you' | 'created';

export type ReviewFileCategory = 'implementation' | 'tests';

export interface ReviewFileStat {
   name: string;
   path: string;
   additions: number;
   deletions: number;
   category: ReviewFileCategory;
}

export interface ReviewCommit {
   sha: string;
   message: string;
   timeAgo: string;
}

export interface DiffLine {
   type: 'context' | 'add' | 'del' | 'skip';
   /** New-file line number (omitted for del/skip). */
   number?: number;
   text?: string;
   /** For 'skip': how many unchanged lines are collapsed. */
   count?: number;
}

export interface FileDiff {
   name: string;
   path: string;
   additions: number;
   deletions: number;
   lines: DiffLine[];
}

export interface GuideSection {
   title: string;
   paragraphs: string[];
   /** File name shown as chips under the prose (stat = "+n -m"). */
   fileRefs: { name: string; path: string; stat: string }[];
   /** Which file diff to show next to the section. */
   diffName: string;
}

export interface ReviewVerdictRow {
   review: string;
   verdict: string;
   critical: string;
   high: string;
   medium: string;
}

export interface ReviewNote {
   author: string;
   timeAgo: string;
   verdictLine: string;
   profileLine: string;
   rows: ReviewVerdictRow[];
   footer?: string;
}

export interface Review {
   /** URL slug. */
   id: string;
   title: string;
   status: ReviewStatus;
   list: ReviewList;
   timeAgo: string;
   repo: string;
   prNumber: number;
   targetBranch: string;
   sourceBranch: string;
   additions: number;
   deletions: number;
   /** Issue this PR resolves. */
   resolves: { identifier: string; title: string };
   checksPassed: number;
   checksTotal: number;
   files: ReviewFileStat[];
   commits: ReviewCommit[];
   /** Description "Summary" bullets — `inline code` supported via backticks. */
   summary: string[];
   testPlan: { text: string; checked: boolean }[];
   deployment?: { project: string; state: string; action: string };
   reviewNote?: ReviewNote;
}

/* -------------------------------------------------------------------------- */
/*                                  Reviews                                   */
/* -------------------------------------------------------------------------- */

export const reviews: Review[] = [];

export const forYouReviews = reviews.filter((review) => review.list === 'for-you');
export const createdReviews = reviews.filter((review) => review.list === 'created');

export function getReviewById(id: string): Review | undefined {
   return reviews.find((review) => review.id === id);
}

/** Diff of one review file. Empty until real reviews arrive. */
export function getReviewFileDiff(_review: Review, file: ReviewFileStat): FileDiff {
   return {
      name: file.name,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      lines: [],
   };
}

/** Guide sections for the review. Empty until real reviews arrive. */
export function getReviewGuide(_review: Review): GuideSection[] {
   return [];
}
