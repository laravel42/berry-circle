import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';

/**
 * What turns a queued run into a running one.
 *
 * Admitting a run and executing it are deliberately separate: `POST` on a task
 * writes a durable row and answers, and this is what later notices the row and
 * does the work. That separation is why a runtime being down is a recorded
 * `run.failed` rather than an HTTP error on a request that already succeeded.
 *
 * Three jobs, all of them the run's lifecycle *outside* the executor:
 *
 *   - **Claim and execute.** Oldest first, bounded by `concurrency`, because
 *     each run holds a container and a model call.
 *   - **Hold a lease, and watch for cancellation.** The lease is renewed on a
 *     timer, which is what makes an abandoned run detectable — see migration
 *     035. The same beat reads the run's status, so `POST /cancel` reaches an
 *     in-flight run: the ledger marks it cancelled, and this aborts the work
 *     that is still going on behind it.
 *   - **Sweep the abandoned.** A run whose lease expired belonged to a process
 *     that is gone. It is failed as retryable, which releases the task — a run
 *     nobody is working on must not hold `active_run_id` forever.
 *
 * Several of these can run at once, on one server or many. The claim is a
 * `SKIP LOCKED` select and the authoritative claim is the ledger's own, so two
 * dispatchers reaching for one run means one of them loses and moves on.
 */

/** How long a claim is good for without a renewal. */
const LEASE_MS = 60_000;

/** Renewed well inside the lease, so one slow beat is not a lost run. */
const HEARTBEAT_MS = 15_000;

/** How often an idle dispatcher looks for work. */
const POLL_MS = 2_000;

export interface Executor {
   execute(runId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface DispatcherOptions {
   sql: Sql;
   executor: Executor;
   logger: Logger;
   /** How many runs this process will execute at once. */
   concurrency?: number;
   pollMs?: number;
   leaseMs?: number;
   heartbeatMs?: number;
   /**
    * The workspaces this dispatcher serves. Omitted — what a deployment does —
    * means every run in the database.
    *
    * A confined dispatcher claims and sweeps only these workspaces' runs, and
    * so cannot touch a run it was not meant to: the claim and the sweep are
    * otherwise table-wide by design, which is right for a server and wrong for
    * a test, where several files hold one database at once and a dispatcher
    * driven by one of them would otherwise execute, lease and abandon the runs
    * another file is asserting about.
    */
   workspaceIds?: readonly string[];
}

export class Dispatcher {
   readonly #sql: Sql;
   readonly #executor: Executor;
   readonly #logger: Logger;
   readonly #concurrency: number;
   readonly #pollMs: number;
   readonly #leaseMs: number;
   readonly #heartbeatMs: number;
   /** The workspaces this dispatcher serves, or null for all of them. */
   readonly #workspaceIds: readonly string[] | null;

   /** Runs this process is executing, and the handle that stops each one. */
   readonly #inflight = new Map<string, AbortController>();

   #running = false;
   #loop: Promise<void> | null = null;
   /** Resolved to cut a poll short — a finished run frees a slot immediately. */
   #wake: (() => void) | null = null;

   constructor(options: DispatcherOptions) {
      this.#sql = options.sql;
      this.#executor = options.executor;
      this.#logger = options.logger;
      this.#concurrency = Math.max(1, options.concurrency ?? 2);
      this.#pollMs = options.pollMs ?? POLL_MS;
      this.#leaseMs = options.leaseMs ?? LEASE_MS;
      this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
      this.#workspaceIds =
         options.workspaceIds && options.workspaceIds.length > 0
            ? [...options.workspaceIds]
            : null;
   }

   /**
    * `AND <column>.workspace_id IN (…)` when this dispatcher is confined, and
    * nothing at all when it serves the whole deployment.
    */
   #scope(alias: string) {
      const ids = this.#workspaceIds;
      if (!ids) return this.#sql``;
      return this.#sql`AND ${this.#sql(alias)}.workspace_id IN ${this.#sql(ids)}`;
   }

   start(): void {
      if (this.#running) return;
      this.#running = true;
      this.#loop = this.#poll();
   }

   /**
    * Stops claiming, and aborts what is still in flight.
    *
    * The runs being aborted are not failed here. Their lease simply stops being
    * renewed, and the next dispatcher to sweep — this process on its next boot,
    * or another one right now — records them as abandoned. Writing that from a
    * process that is shutting down would be a promise it might not keep.
    */
   async stop(): Promise<void> {
      this.#running = false;
      this.#wake?.();
      for (const controller of this.#inflight.values()) controller.abort();
      await this.#loop?.catch(() => undefined);
      this.#loop = null;
   }

   /** What this process is working on. For `/metrics` and for tests. */
   get inflight(): number {
      return this.#inflight.size;
   }

   /**
    * Looks for work now rather than at the next poll.
    *
    * For a caller that just queued something it is waiting on — a completion
    * holds an HTTP request open until its task finishes.
    */
   nudge(): void {
      this.#wake?.();
   }

   async #poll(): Promise<void> {
      while (this.#running) {
         try {
            await this.tick();
         } catch (error) {
            // A dispatcher that dies on a failed query stops the product. It
            // says so and tries again on the next beat.
            this.#logger.error('dispatcher poll failed', { error: message(error) });
         }
         await this.#sleep(this.#pollMs);
      }
   }

   /**
    * One beat of the loop: sweep what was abandoned, take what fits.
    *
    * Public because it is the unit of work, and driving it directly is the
    * only way to test the claim without waiting on a timer.
    */
   async tick(): Promise<void> {
      await this.sweep();
      const free = this.#concurrency - this.#inflight.size;
      if (free > 0) {
         for (const runId of await this.#claim(free)) this.#start(runId);
      }
   }

   /**
    * Takes up to `limit` runs, oldest first.
    *
    * `SKIP LOCKED` rather than a lock wait: another dispatcher holding a row
    * has already taken it, and queuing behind it would only mean claiming a
    * run that is no longer claimable.
    *
    * A lease is written before the ledger's claim, so a process that dies in
    * between leaves a run that is reclaimable rather than one that is stuck.
    */
   async #claim(limit: number): Promise<string[]> {
      // Priority first, then age. A runtime with a concurrency limit gets at
      // most `limit - busy` new claims per statement: `slot` numbers each
      // runtime's candidates in claim order, so one tick can never hand a
      // limit-1 runtime two runs (a plain `busy < limit` filter is evaluated
      // once for every candidate and would). The window lives in a CTE because
      // Postgres refuses FOR UPDATE beside a window function. Two dispatchers
      // claiming in the same instant can each read the same `busy`; that
      // overshoot is bounded by the number of dispatchers and ends at the
      // next tick.
      //
      // The lock is taken in a MATERIALIZED CTE, not `WHERE id IN (SELECT …
      // LIMIT … FOR UPDATE)`: the planner may re-run that subquery per row,
      // and a re-run `SKIP LOCKED` finds the next rows, so LIMIT stops
      // bounding the claim.
      const rows = await this.#sql`
         WITH candidate AS (
            SELECT ranked.id, ranked.priority, ranked.created_at FROM (
               SELECT r.id, r.priority, r.created_at, rt.concurrency_limit,
                      row_number() OVER (PARTITION BY r.runtime_id
                                         ORDER BY r.priority DESC, r.created_at ASC) AS slot,
                      (SELECT count(*) FROM runs AS busy
                        WHERE busy.runtime_id = r.runtime_id
                          AND busy.status IN ('queued', 'running')
                          AND (busy.dispatch_state <> 'pending'
                               OR busy.dispatch_lease_until > now())) AS busy_count
                 FROM runs AS r
                 LEFT JOIN agent_runtimes AS rt ON rt.id = r.runtime_id
                WHERE r.status = 'queued'
                  AND r.dispatch_state = 'pending'
                  AND (r.dispatch_lease_until IS NULL OR r.dispatch_lease_until < now())
                  AND (rt.id IS NULL OR rt.status <> 'disabled')
                  ${this.#scope('r')}
                  -- One task per chat session at a time (spec 2.2a): a
                  -- session's run waits while another of its runs is running
                  -- or is ahead of it in claim order.
                  AND (r.chat_session_id IS NULL OR NOT EXISTS (
                         SELECT 1 FROM runs AS o
                          WHERE o.chat_session_id = r.chat_session_id AND o.id <> r.id
                            AND (o.status = 'running'
                                 OR (o.status = 'queued'
                                     AND (o.priority > r.priority
                                          OR (o.priority = r.priority
                                              AND (o.created_at, o.id) < (r.created_at, r.id)))))))
            ) AS ranked
            WHERE ranked.concurrency_limit IS NULL
               OR ranked.busy_count + ranked.slot <= ranked.concurrency_limit
         ),
         picked AS MATERIALIZED (
            SELECT r.id FROM runs AS r JOIN candidate AS c ON c.id = r.id
             WHERE r.status = 'queued'
               AND r.dispatch_state = 'pending'
               AND (r.dispatch_lease_until IS NULL OR r.dispatch_lease_until < now())
             ORDER BY c.priority DESC, c.created_at ASC
             LIMIT ${limit}
             FOR UPDATE OF r SKIP LOCKED
         )
         UPDATE runs
            SET dispatch_lease_until = now() + ${`${this.#leaseMs} milliseconds`}::interval
           FROM picked
          WHERE runs.id = picked.id
          RETURNING runs.id`;
      return rows.map((row) => row.id as string);
   }

   /**
    * Fails runs whose lease has expired.
    *
    * `dispatch_state <> 'pending'` is what separates abandoned from waiting: a
    * run still pending has not been claimed by anyone, expired lease or not,
    * and belongs to `#claim` rather than here.
    *
    * Retryable, and phrased for whoever reads it on the task: nothing about
    * the work was wrong, the process doing it went away.
    */
   async sweep(): Promise<void> {
      const rows = await this.#sql`
         SELECT id FROM runs
          WHERE status IN ('queued', 'running')
            AND dispatch_state <> 'pending'
            AND dispatch_lease_until < now()
            ${this.#scope('runs')}
          LIMIT 20`;

      for (const row of rows) {
         const runId = row.id as string;
         // Never a run this process is executing: its lease is being renewed.
         if (this.#inflight.has(runId)) continue;
         try {
            await this.#abandon(runId);
            this.#logger.info('recorded an abandoned run', { runId });
         } catch (error) {
            this.#logger.error('could not record an abandoned run', {
               runId,
               error: message(error),
            });
         }
      }
   }

   #start(runId: string): void {
      const controller = new AbortController();
      this.#inflight.set(runId, controller);

      const heartbeat = setInterval(() => {
         void this.beat(runId);
      }, this.#heartbeatMs);
      // The process must be able to exit while a beat is scheduled.
      heartbeat.unref?.();

      void this.#executor
         .execute(runId, controller.signal)
         .then((outcome) => {
            this.#logger.info('run finished', { runId, ...summarise(outcome) });
         })
         .catch((error) => {
            // The executor records the run's own failure; this is the line
            // that says which process was carrying it when it happened.
            this.#logger.error('run did not finish', { runId, error: message(error) });
         })
         .finally(() => {
            clearInterval(heartbeat);
            this.#inflight.delete(runId);
            // A freed slot is worth a poll now rather than at the next beat.
            this.#wake?.();
         });
   }

   /**
    * One beat: renew the lease, and stop the run if it was cancelled.
    *
    * Both in one statement, because they are the same question — the row says
    * whether this process should still be working on it. `RETURNING status`
    * with no `WHERE` on status would renew a cancelled run's lease, so the
    * renewal is conditional and the read is not.
    */
   async beat(runId: string): Promise<void> {
      const controller = this.#inflight.get(runId);
      if (!controller) return;
      try {
         const [row] = await this.#sql`
            UPDATE runs
               SET dispatch_lease_until = CASE
                      WHEN status IN ('queued', 'running')
                      THEN now() + ${`${this.#leaseMs} milliseconds`}::interval
                      ELSE dispatch_lease_until
                   END
             WHERE id = ${runId}
             RETURNING status`;

         // Cancelled, or finished by something else. Either way this process
         // is no longer the one doing it, and an aborted model call is one
         // nobody pays for.
         if (!row || !['queued', 'running'].includes(row.status as string)) {
            controller.abort();
         }
      } catch (error) {
         // Not fatal: the lease outlives several beats, so a transient failure
         // here costs nothing. Losing every beat is what ends the run, and
         // that is the case the lease exists for.
         this.#logger.error('lease renewal failed', { runId, error: message(error) });
      }
   }

   async #abandon(runId: string): Promise<void> {
      // Written directly rather than through the ledger's `fail`, because that
      // allocates a sequence and appends an event, and this must also hold for
      // a run whose ledger the dead process left mid-write. The status change
      // and the release of the task are what matter; the event follows.
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [run] = await tx`
            SELECT id, issue_id, board_id, status FROM runs
             WHERE id = ${runId} AND status IN ('queued', 'running')
               AND dispatch_lease_until < now()
             FOR UPDATE`;
         // Someone else swept it, or it finished between the select and here.
         if (!run) return;

         await tx`
            UPDATE runs
               SET status = 'failed',
                   failure_code = 'DISPATCH_ABANDONED',
                   failure_message = 'The process running this task stopped before it finished.',
                   failure_retryable = true,
                   dispatch_state = 'failed',
                   dispatch_lease_until = NULL,
                   completed_at = now(),
                   updated_at = now()
             WHERE id = ${runId}`;
         await tx`
            UPDATE issues SET active_run_id = NULL, updated_at = now()
             WHERE id = ${run.issue_id} AND active_run_id = ${runId}`;

         const [sequence] = await tx`SELECT berry_allocate_run_event_sequence(${runId}) AS n`;
         await tx`
            INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
            VALUES (gen_random_uuid(), ${runId}, ${run.board_id}, ${run.issue_id},
                    ${Number(sequence!.n)}, 'run.failed',
                    ${tx.json({
                       failure: {
                          code: 'DISPATCH_ABANDONED',
                          message: 'The process running this task stopped before it finished.',
                          retryable: true,
                       },
                    } as never)},
                    true)`;
      });
   }

   /** Sleeps, unless a finished run wakes it first. */
   #sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
         const timer = setTimeout(finish, ms);
         timer.unref?.();
         this.#wake = finish;

         function finish(): void {
            clearTimeout(timer);
            resolve();
         }
      });
   }
}

function summarise(outcome: unknown): Record<string, unknown> {
   if (!outcome || typeof outcome !== 'object') return {};
   const { status, toolCalls } = outcome as { status?: unknown; toolCalls?: unknown };
   return { status, toolCalls };
}

function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}
