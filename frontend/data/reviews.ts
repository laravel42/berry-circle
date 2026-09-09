/**
 * Review presentation types shared by the review components.
 *
 * The list and detail themselves come from the API (`lib/reviews.ts`). What
 * lives here is the vocabulary the diff renderer draws with.
 */

export type ReviewStatus = 'open' | 'merged' | 'closed';

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
