import type { Sql } from '../db/pool.ts';

/**
 * What an operator needs to see, in the one format every scraper reads.
 *
 * Deliberately small, and deliberately about the product rather than the
 * process. Node's heap size tells you nothing about whether Berry is working;
 * "eleven runs queued and none running" tells you the dispatcher is down, and
 * that is the failure a self-hosted Berry actually has.
 *
 * Every number is counted at scrape time from the tables that hold it. That is
 * a handful of aggregate queries per scrape rather than a set of counters kept
 * in memory — which would be cheaper, and would also be wrong the moment a
 * second server joined or this one restarted. The queries are bounded by the
 * number of distinct statuses, not by rows.
 */

export interface MetricsSource {
   sql: Sql;
   /** How many runs this process is executing. Null when it does not dispatch. */
   inflight: () => number | null;
   version: string;
}

/**
 * The Prometheus text exposition format, by hand.
 *
 * A client library would be one dependency for four metric families, and the
 * format is six lines of rules: HELP, TYPE, then `name{labels} value`.
 */
export async function renderMetrics(source: MetricsSource): Promise<string> {
   const lines: string[] = [];

   const write = (
      name: string,
      help: string,
      type: 'gauge' | 'counter',
      samples: Array<{ labels?: Record<string, string>; value: number }>
   ): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const sample of samples) {
         lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
      }
   };

   write('berry_build_info', 'Berry server build, as a constant 1.', 'gauge', [
      { labels: { version: source.version }, value: 1 },
   ]);

   // Reachability first, and separately from the counts: a scrape that finds
   // `berry_database_up 0` explains every other number being absent, which a
   // failed scrape does not.
   let databaseUp = 1;
   let runs: Array<{ labels: Record<string, string>; value: number }> = [];
   let issues: Array<{ labels: Record<string, string>; value: number }> = [];
   let oldestQueued = 0;
   try {
      const runRows = await source.sql`
         SELECT status::text AS status, count(*)::int AS n FROM runs GROUP BY status`;
      runs = runRows.map((row) => ({
         labels: { status: row.status as string },
         value: Number(row.n),
      }));

      const issueRows = await source.sql`
         SELECT status::text AS status, count(*)::int AS n
           FROM issues WHERE deleted_at IS NULL GROUP BY status`;
      issues = issueRows.map((row) => ({
         labels: { status: row.status as string },
         value: Number(row.n),
      }));

      const [waiting] = await source.sql`
         SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::float8 AS seconds
           FROM runs WHERE status = 'queued'`;
      oldestQueued = Number(waiting!.seconds);
   } catch {
      // Reported rather than raised: a metrics endpoint that 500s during an
      // outage is one that tells you nothing exactly when you need it.
      databaseUp = 0;
   }

   write('berry_database_up', 'Whether the database answered this scrape.', 'gauge', [
      { value: databaseUp },
   ]);

   if (databaseUp === 1) {
      write('berry_runs', 'Runs by status.', 'gauge', runs);
      write('berry_issues', 'Tasks by status, excluding deleted.', 'gauge', issues);
      // The number that says the dispatcher has stopped. A queue with work in
      // it is normal; a queue whose oldest item is an hour old is not.
      write(
         'berry_run_queue_wait_seconds',
         'Age of the oldest queued run. Zero when the queue is empty.',
         'gauge',
         [{ value: Math.round(oldestQueued) }]
      );
   }

   const inflight = source.inflight();
   write(
      'berry_runs_inflight',
      'Runs this process is executing. Absent on a server that does not dispatch.',
      'gauge',
      inflight === null ? [] : [{ value: inflight }]
   );

   return `${lines.join('\n')}\n`;
}

/**
 * Prometheus label values escape backslash, quote and newline, and nothing
 * else. Berry's label values are statuses and a version string, but escaping
 * them anyway is what keeps a future label from breaking every scrape.
 */
function renderLabels(labels: Record<string, string> | undefined): string {
   if (!labels || Object.keys(labels).length === 0) return '';
   const pairs = Object.entries(labels).map(
      ([key, value]) =>
         `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
   );
   return `{${pairs.join(',')}}`;
}
