import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMetrics } from './metrics.ts';
import type { Sql } from '../db/pool.ts';

/**
 * The scrape.
 *
 * Offline: the database is a fake that answers the three aggregate queries, so
 * what is under test is the exposition format and the failure behaviour rather
 * than SQL. The format matters because a scraper does not report a parse
 * error to anyone — it just shows a gap.
 */

/** Answers each query by shape, in the order `renderMetrics` asks them. */
function fakeSql(answers: unknown[][], onCall?: () => void): Sql {
   let index = 0;
   const sql = (() => {
      onCall?.();
      return Promise.resolve(answers[index++] ?? []);
   }) as unknown as Sql;
   return sql;
}

const RUNS = [
   { status: 'queued', n: 2 },
   { status: 'succeeded', n: 40 },
];
const ISSUES = [{ status: 'todo', n: 7 }];
const WAIT = [{ seconds: 91.6 }];

test('the exposition format is what a scraper parses', async () => {
   const text = await renderMetrics({
      sql: fakeSql([RUNS, ISSUES, WAIT]),
      inflight: () => 3,
      version: '1.2.3',
   });

   // Every family carries its HELP and TYPE, and every sample is one line of
   // `name{labels} value`.
   assert.match(text, /# HELP berry_runs Runs by status\.\n# TYPE berry_runs gauge\n/);
   assert.match(text, /^berry_runs\{status="queued"\} 2$/m);
   assert.match(text, /^berry_runs\{status="succeeded"\} 40$/m);
   assert.match(text, /^berry_issues\{status="todo"\} 7$/m);
   assert.match(text, /^berry_build_info\{version="1\.2\.3"\} 1$/m);
   assert.match(text, /^berry_runs_inflight 3$/m);
   // Rounded, because a gauge with fifteen decimals is noise in every graph.
   assert.match(text, /^berry_run_queue_wait_seconds 92$/m);
   assert.ok(text.endsWith('\n'));
});

test('a database that is down is reported, not raised', async () => {
   // A metrics endpoint that 500s during an outage tells you nothing exactly
   // when you need it. `berry_database_up 0` explains the missing families.
   const text = await renderMetrics({
      sql: (() => Promise.reject(new Error('connection refused'))) as unknown as Sql,
      inflight: () => 0,
      version: '1.2.3',
   });

   assert.match(text, /^berry_database_up 0$/m);
   assert.ok(!text.includes('berry_runs{'), 'counts were reported without a database');
   // The two that do not need the database are still there.
   assert.match(text, /^berry_build_info\{version="1\.2\.3"\} 1$/m);
   assert.match(text, /^berry_runs_inflight 0$/m);
});

test('a server that does not dispatch has no inflight gauge, rather than a zero', async () => {
   // Zero would read as "running none right now", which is a different claim
   // from "this process runs none".
   const text = await renderMetrics({
      sql: fakeSql([RUNS, ISSUES, WAIT]),
      inflight: () => null,
      version: '1.2.3',
   });
   assert.match(text, /# TYPE berry_runs_inflight gauge/);
   assert.ok(!/^berry_runs_inflight /m.test(text));
});

test('an empty database renders families with no samples, not a broken scrape', async () => {
   const text = await renderMetrics({
      sql: fakeSql([[], [], [{ seconds: 0 }]]),
      inflight: () => 0,
      version: '1.2.3',
   });
   assert.match(text, /# TYPE berry_runs gauge/);
   assert.match(text, /^berry_run_queue_wait_seconds 0$/m);
});

test('label values are escaped, so one odd value cannot break every scrape', async () => {
   const text = await renderMetrics({
      sql: fakeSql([[{ status: 'we"ird\\', n: 1 }], [], [{ seconds: 0 }]]),
      inflight: () => 0,
      version: '1.2.3',
   });
   assert.match(text, /^berry_runs\{status="we\\"ird\\\\"\} 1$/m);
});

test('the queue age is one query, not one per run', async () => {
   // The point of asking PostgreSQL for MIN(created_at): a scrape must not
   // walk the runs table, or a busy Berry pays for its own monitoring.
   let calls = 0;
   await renderMetrics({
      sql: fakeSql([RUNS, ISSUES, WAIT], () => {
         calls += 1;
      }),
      inflight: () => 0,
      version: '1.2.3',
   });
   assert.equal(calls, 3);
});
