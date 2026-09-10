import type { Sql } from '../db/pool.ts';
import type { ApiScope } from '../public-api/scopes.ts';
import { PluginUnreachable } from './errors.ts';
import type { PluginNetwork } from './net.ts';
import type { PluginInstallation, PluginRepository } from './repository.ts';
import type { PluginRuntimeStore } from './runtime-store.ts';
import { SIGNATURE_HEADER, signPayload } from './signing.ts';

/**
 * Berry calling plugins.
 *
 * Event hooks follow `outbox_events` through one cursor row. The row is locked
 * FOR UPDATE SKIP LOCKED, so across several servers exactly one reads each
 * batch. The cursor advances before delivery, so delivery is at most once: a
 * plugin that was down misses the event rather than receiving it twice, and
 * the invocation log shows the failure. Events are read with a two-second lag
 * so a transaction that commits slightly out of order is not skipped. Only
 * subscribed topics are read, and when a batch is not full the cursor jumps
 * to the lag horizon. A plugin installed later therefore sees only events
 * from after its install.
 *
 * Schedule hooks claim due rows the same way and move `next_fire_at` forward
 * in the same statement.
 *
 * A plugin that writes back on the event it was told about (a comment on
 * `comment.created`) will be told about its own write. That is the plugin's
 * loop to break; the SDK docs say so.
 */

export const HOOK_TOKEN_TTL_MS = 10 * 60_000;

/**
 * The read scope an event's payload needs. Subscribing to a topic is not a
 * grant: a plugin without the scope is told that the event happened (id, type,
 * time) but not what it says. Families with no public API scope are never
 * shared.
 */
export function payloadScope(topic: string): ApiScope | null {
   if (topic.startsWith('issue.')) return 'issues:read';
   if (topic.startsWith('comment.')) return 'comments:read';
   return null;
}

export interface CallerOptions {
   plugins: PluginRepository;
   runtime: PluginRuntimeStore;
   network: PluginNetwork;
   publicUrl: string | null;
   clock?: () => Date;
}

export class PluginCaller {
   readonly #options: CallerOptions;
   readonly #clock: () => Date;

   constructor(options: CallerOptions) {
      this.#options = options;
      this.#clock = options.clock ?? (() => new Date());
   }

   async call(
      installation: PluginInstallation,
      input: { kind: 'event' | 'schedule'; trigger: string; path: string; event?: unknown }
   ): Promise<'ok' | 'error'> {
      const { plugins, runtime, network, publicUrl } = this.#options;
      const started = this.#clock().getTime();
      let status: 'ok' | 'error' = 'error';
      let httpStatus: number | null = null;
      let error: string | null = null;
      try {
         const { token, expiresAt } = await runtime.mintToken({
            workspaceId: installation.workspaceId,
            installationId: installation.id,
            scopes: installation.grantedScopes,
            ttlMs: HOOK_TOKEN_TTL_MS,
         });
         const body = JSON.stringify({
            type: input.kind,
            trigger: input.trigger,
            pluginKey: installation.key,
            installationId: installation.id,
            workspaceId: installation.workspaceId,
            config: installation.config,
            secrets: await plugins.openSecrets(installation.workspaceId, installation.id),
            api: { url: publicUrl, token, expiresAt },
            event: input.event ?? null,
         });
         const secret = await plugins.signingSecret(installation.workspaceId, installation.id);
         const timestamp = Math.floor(this.#clock().getTime() / 1000);
         const base = installation.manifest.baseUrl.replace(/\/+$/, '');
         const response = await network.request(`${base}${input.path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signPayload(secret, timestamp, body) },
            body,
            timeoutMs: 10_000,
            maxBytes: 65_536,
         });
         httpStatus = response.status;
         status = response.status >= 200 && response.status < 300 ? 'ok' : 'error';
         if (status === 'error') error = `plugin answered ${response.status}`;
      } catch (cause) {
         // Only our own messages are recorded: an arbitrary error could carry
         // a URL with a credential in it.
         error = cause instanceof PluginUnreachable ? cause.message : 'plugin call failed';
      }
      await runtime.recordInvocation({
         workspaceId: installation.workspaceId,
         installationId: installation.id,
         kind: input.kind,
         trigger: input.trigger,
         status,
         httpStatus,
         durationMs: this.#clock().getTime() - started,
         error,
      });
      return status;
   }
}

export interface RunnerOptions {
   sql: Sql;
   plugins: PluginRepository;
   caller: PluginCaller;
   batchSize?: number;
   onError?: (message: string, error: unknown) => void;
}

export class PluginHookRunner {
   readonly #options: RunnerOptions;
   readonly #batch: number;
   #timer: NodeJS.Timeout | null = null;
   #running: Promise<unknown> | null = null;

   constructor(options: RunnerOptions) {
      this.#options = options;
      this.#batch = options.batchSize ?? 100;
   }

   async tick(): Promise<{ events: number; schedules: number }> {
      const events = await this.#deliverEvents();
      const schedules = await this.#fireSchedules();
      return { events, schedules };
   }

   start(intervalMs = 5_000): void {
      if (this.#timer) return;
      void this.#options.sql`INSERT INTO plugin_event_cursor (id) VALUES (1) ON CONFLICT DO NOTHING`.catch((error: unknown) =>
         this.#options.onError?.('plugin cursor init failed', error)
      );
      this.#timer = setInterval(() => {
         if (this.#running) return;
         this.#running = this.tick()
            .catch((error: unknown) => this.#options.onError?.('plugin hook tick failed', error))
            .finally(() => {
               this.#running = null;
            });
      }, intervalMs);
      this.#timer.unref();
   }

   async stop(): Promise<void> {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      await this.#running;
   }

   async #deliverEvents(): Promise<number> {
      const { sql, plugins, caller } = this.#options;
      const rows = await sql.begin(async (tx) => {
         const [cursor] = await tx`
            SELECT occurred_at, event_id FROM plugin_event_cursor WHERE id = 1 FOR UPDATE SKIP LOCKED`;
         if (!cursor) return [];
         // Read only topics some enabled plugin subscribes to. outbox_events also
         // carries high-volume topics (run.output.delta from src/runs/ledger.ts);
         // without this filter they fill every batch, and the cursor falls
         // further behind on every tick.
         const subscribed = await tx`
            SELECT DISTINCT e.topic
              FROM plugin_installations AS i,
                   jsonb_array_elements(i.manifest->'hooks') AS h,
                   jsonb_array_elements_text(h->'events') AS e(topic)
             WHERE i.enabled AND h->>'trigger' = 'event'`;
         const topics = subscribed.map((row) => row.topic as string);
         const [clock] = await tx`SELECT now() - interval '2 seconds' AS horizon`;
         const horizon = clock?.horizon as string;
         const found =
            topics.length === 0
               ? []
               : await tx`
                  SELECT id, topic, workspace_id, payload, occurred_at FROM outbox_events
                   WHERE (occurred_at, id) > (${cursor.occurred_at as string}::timestamptz, ${cursor.event_id as string}::uuid)
                     AND occurred_at <= ${horizon}::timestamptz
                     AND topic = ANY(${tx.array(topics)}::text[])
                   ORDER BY occurred_at, id
                   LIMIT ${this.#batch}`;
         const last = found.at(-1);
         if (last && found.length === this.#batch) {
            // A full batch: there may be more before the horizon. Resume after the last row.
            await tx`
               UPDATE plugin_event_cursor SET occurred_at = ${last.occurred_at as string}, event_id = ${last.id as string}
                WHERE id = 1`;
         } else {
            // Every subscribed event up to the horizon has been read, so jump there.
            // The all-f uuid sorts after every id at that instant.
            await tx`
               UPDATE plugin_event_cursor
                  SET occurred_at = ${horizon}::timestamptz, event_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                WHERE id = 1`;
         }
         return found;
      });

      type OutboxRow = {
         id: string;
         topic: string;
         workspace_id: string | null;
         payload: unknown;
         occurred_at: string;
      };
      const outbox = rows as unknown as OutboxRow[];
      const byWorkspace = new Map<string, OutboxRow[]>();
      for (const row of outbox) {
         const workspaceId = row.workspace_id as string | null;
         if (!workspaceId) continue;
         const list = byWorkspace.get(workspaceId) ?? [];
         list.push(row);
         byWorkspace.set(workspaceId, list);
      }
      let delivered = 0;
      for (const [workspaceId, events] of byWorkspace) {
         const installations = await plugins.listEnabled(workspaceId);
         for (const installation of installations) {
            for (const hook of installation.manifest.hooks) {
               if (hook.trigger !== 'event') continue;
               for (const event of events) {
                  if (!hook.events.includes(event.topic as string)) continue;
                  const envelope = event.payload as { payload?: unknown } | null;
                  const needed = payloadScope(event.topic as string);
                  const shared = needed !== null && installation.grantedScopes.includes(needed);
                  await caller.call(installation, {
                     kind: 'event',
                     trigger: event.topic as string,
                     path: hook.path,
                     event: {
                        id: event.id,
                        type: event.topic,
                        occurredAt: event.occurred_at,
                        payload: shared ? (envelope?.payload ?? null) : null,
                     },
                  });
                  delivered += 1;
               }
            }
         }
      }
      return delivered;
   }

   async #fireSchedules(): Promise<number> {
      const { sql, plugins, caller } = this.#options;
      const due = await sql`
         UPDATE plugin_hook_state AS s
            SET last_fired_at = now(), next_fire_at = now() + make_interval(mins => s.interval_minutes)
          WHERE (s.installation_id, s.hook_key) IN (
                SELECT installation_id, hook_key FROM plugin_hook_state
                 WHERE next_fire_at <= now()
                 ORDER BY next_fire_at
                 LIMIT ${this.#batch}
                 FOR UPDATE SKIP LOCKED)
         RETURNING s.installation_id, s.workspace_id, s.hook_key`;
      let fired = 0;
      for (const row of due) {
         const installation = await plugins
            .get(row.workspace_id as string, row.installation_id as string)
            .catch(() => null);
         if (!installation || !installation.enabled) continue;
         const hook = installation.manifest.hooks.find((h) => h.key === row.hook_key && h.trigger === 'schedule');
         if (!hook) continue;
         await caller.call(installation, { kind: 'schedule', trigger: hook.key, path: hook.path });
         fired += 1;
      }
      return fired;
   }
}
