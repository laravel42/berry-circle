import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findLinkIntents, pullRequestState, rollupChecks, statusPathToDone } from './pr-linking.ts';

const base = { prefix: 'ABC', branch: 'main', title: '', body: null };

describe('which issues a pull request names', () => {
   test('a key in the branch links, whatever its case', () => {
      assert.deepEqual(findLinkIntents({ ...base, branch: 'feature/abc-12-add-thing' }), [
         { number: 12, closeIntent: false, source: 'branch' },
      ]);
   });

   test('a key in the title links without closing', () => {
      assert.deepEqual(findLinkIntents({ ...base, title: 'ABC-7 tidy the parser' }), [
         { number: 7, closeIntent: false, source: 'title' },
      ]);
   });

   test('a closing keyword before a key in the body carries close intent', () => {
      assert.deepEqual(findLinkIntents({ ...base, body: 'Some context.\n\nFixes ABC-7' }), [
         { number: 7, closeIntent: true, source: 'body' },
      ]);
      for (const keyword of ['close', 'closes', 'closed', 'fix', 'fixed', 'resolve', 'resolves:', 'Resolved']) {
         const [intent] = findLinkIntents({ ...base, body: `${keyword} abc-9` });
         assert.equal(intent?.closeIntent, true, keyword);
      }
   });

   test('a word that merely ends in a keyword does not close', () => {
      const [intent] = findLinkIntents({ ...base, body: 'prefix ABC-9' });
      assert.equal(intent?.closeIntent, false);
   });

   test('another workspace’s prefix is never read as this one’s', () => {
      assert.deepEqual(findLinkIntents({ ...base, title: 'XYZ-3 and XABC-4' }), []);
   });

   test('a longer number is not read as its prefix', () => {
      assert.deepEqual(findLinkIntents({ ...base, title: 'ABC-123' }), [
         { number: 123, closeIntent: false, source: 'title' },
      ]);
   });

   test('one issue named in several places is one link, closing if any place closes', () => {
      assert.deepEqual(
         findLinkIntents({ ...base, branch: 'abc-5-x', title: 'ABC-5', body: 'closes ABC-5' }),
         [{ number: 5, closeIntent: true, source: 'branch' }]
      );
   });

   test('a prefix with regex syntax in it is matched literally', () => {
      assert.deepEqual(findLinkIntents({ ...base, prefix: 'A.C', title: 'ABC-1 A.C-2' }), [
         { number: 2, closeIntent: false, source: 'title' },
      ]);
   });

   test('an empty prefix names nothing', () => {
      assert.deepEqual(findLinkIntents({ ...base, prefix: '', title: '-1' }), []);
   });
});

describe('the legal way to done after a merge', () => {
   const rules: Record<string, string[]> = {
      backlog: ['todo', 'cancelled'],
      todo: ['backlog', 'in_progress', 'blocked', 'cancelled'],
      in_progress: ['todo', 'in_review', 'blocked', 'cancelled'],
      in_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
      done: ['in_review'],
      blocked: ['todo', 'in_progress', 'cancelled'],
      cancelled: ['backlog', 'todo'],
   };
   const allowed = (from: string, to: string) => from === to || (rules[from]?.includes(to) ?? false);

   test('walks each step the state machine allows, shortest first', () => {
      assert.deepEqual(statusPathToDone('in_review', allowed), ['done']);
      assert.deepEqual(statusPathToDone('in_progress', allowed), ['in_review', 'done']);
      assert.deepEqual(statusPathToDone('backlog', allowed), ['todo', 'in_progress', 'in_review', 'done']);
      assert.deepEqual(statusPathToDone('blocked', allowed), ['in_progress', 'in_review', 'done']);
   });

   test('leaves a finished or cancelled issue alone', () => {
      assert.deepEqual(statusPathToDone('done', allowed), []);
      assert.deepEqual(statusPathToDone('cancelled', allowed), []);
   });

   test('an unknown status has no path', () => {
      assert.deepEqual(statusPathToDone('mystery', allowed), []);
   });
});

describe('the state a pull request is shown in', () => {
   test('merged wins over closed, draft only while open', () => {
      assert.equal(pullRequestState({ state: 'closed', merged: true, draft: false }), 'merged');
      assert.equal(pullRequestState({ state: 'closed', merged: false, draft: true }), 'closed');
      assert.equal(pullRequestState({ state: 'open', merged: false, draft: true }), 'draft');
      assert.equal(pullRequestState({ state: 'open', merged: false, draft: false }), 'open');
   });
});

describe('rolling checks up to one verdict', () => {
   test('nothing reported is none', () => {
      assert.equal(rollupChecks([]), 'none');
   });

   test('any failure fails the whole', () => {
      assert.equal(
         rollupChecks([
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'timed_out' },
            { status: 'in_progress', conclusion: null },
         ]),
         'failure'
      );
   });

   test('anything unfinished is pending', () => {
      assert.equal(
         rollupChecks([
            { status: 'completed', conclusion: 'success' },
            { status: 'queued', conclusion: null },
         ]),
         'pending'
      );
   });

   test('success and skipped pass; all neutral is neutral', () => {
      assert.equal(
         rollupChecks([
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'skipped' },
         ]),
         'success'
      );
      assert.equal(rollupChecks([{ status: 'completed', conclusion: 'neutral' }]), 'neutral');
   });
});
