import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { assertSchedule, nextFireAfter } from './cron.ts';
import { writeAutopilotEvent } from './events.ts';
import { hashToken, newSigningSecret, newWebhookToken, tokenHint } from './signing.ts';

/**
 * Autopilots, their triggers, and the record of what they did.
 *
 * Every method takes the workspace the caller was confirmed in and puts it in
 * the WHERE clause, so a row in another workspace is simply not there
 * (`NotFound`), never "there but forbidden".
 *
 * Secrets: a webhook's token is kept as a hash and its signing secret sealed.
 * Both are returned in plaintext exactly once — from the call that made them
 * — and no read path can produce them again.
 */

export const ASSIGNEE_TYPES = ['agent', 'squad'] as const;
export const EXECUTION_MODES = ['create_issue', 'fixed_issue'] as const;
export const QUOTA_PERIODS = ['none', 'hour', 'day', 'week'] as const;

export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];
export type AutopilotStatus = 'active' | 'paused' | 'archived';
export type RunSource = 'cron' | 'webhook' | 'manual' | 'replay';
export type RunStatus = 'pending' | 'enqueued' | 'skipped' | 'failed';
export type DeliveryStatus = 'accepted' | 'filtered' | 'rejected' | 'failed';
export type MemberRole = 'collaborator' | 'subscriber';

export interface AutopilotDraft {
   name: string;
   description: string | null;
   assigneeType: AssigneeType;
   assigneeId: string;
   promptTemplate: string;
   executionMode: ExecutionMode;
   boardId: string | null;
   issueId: string | null;
   quotaPeriod: QuotaPeriod;
   quotaMax: number | null;
}

export interface Autopilot extends AutopilotDraft {
   id: string;
   workspaceId: string;
   status: AutopilotStatus;
   version: number;
   createdBy: string | null;
   /**
    * What makes it run, so a list can be filtered by it without asking after
    * each autopilot's triggers in turn. Empty when only a person can fire it.
    */
   triggerKinds: Array<'cron' | 'webhook'>;
   createdAt: string;
   updatedAt: string;
}

/**
 * A partial change. `undefined` means "not given", the same as absent: a
 * parsed request body carries every optional key it did not receive.
 */
export interface AutopilotPatch {
   name?: string | undefined;
   description?: string | null | undefined;
   assigneeType?: AssigneeType | undefined;
   assigneeId?: string | undefined;
   promptTemplate?: string | undefined;
   executionMode?: ExecutionMode | undefined;
   boardId?: string | null | undefined;
   issueId?: string | null | undefined;
   quotaPeriod?: QuotaPeriod | undefined;
   quotaMax?: number | null | undefined;
   status?: 'active' | 'paused' | undefined;
}

export interface AutopilotVersion {
   version: number;
   snapshot: AutopilotDraft;
   createdBy: string | null;
   createdAt: string;
}

export interface AutopilotMember {
   userId: string;
   role: MemberRole;
   createdAt: string;
}

export interface AutopilotTrigger {
   id: string;
   autopilotId: string;
   kind: 'cron' | 'webhook';
   enabled: boolean;
   cronExpression: string | null;
   timezone: string | null;
   nextFireAt: string | null;
   lastFiredAt: string | null;
   tokenHint: string | null;
   eventFilters: string[];
   createdAt: string;
   updatedAt: string;
}

export interface TriggerPatch {
   enabled?: boolean | undefined;
   expression?: string | undefined;
   timezone?: string | undefined;
   eventFilters?: string[] | undefined;
}

export interface WebhookSecrets {
   token: string;
   signingSecret: string;
}

export interface AutopilotRunRecord {
   id: string;
   autopilotId: string;
   autopilotVersion: number;
   triggerId: string | null;
   source: RunSource;
   status: RunStatus;
   reasonCode: string | null;
   reasonMessage: string | null;
   issueId: string | null;
   runId: string | null;
   taskStatus: string | null;
   slot: string | null;
   requestedBy: string | null;
   createdAt: string;
}

export interface WebhookDeliveryRecord {
   id: string;
   autopilotId: string;
   triggerId: string | null;
   event: string | null;
   status: DeliveryStatus;
   failureReason: string | null;
   autopilotRunId: string | null;
   replayOf: string | null;
   receivedAt: string;
}

/** A definition this workspace cannot hold. `field` is a JSON pointer into the request. */
export class InvalidAutopilot extends Error {
   override readonly name = 'InvalidAutopilot';
   readonly field: string;

   constructor(field: string, message: string) {
      super(message);
      this.field = field;
   }
}

const HISTORY_LIMIT = 100;

type Row = Record<string, unknown>;

export class AutopilotRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #clock: () => Date;

   constructor(options: { sql: Sql; sealer: Sealer; clock?: () => Date }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#clock = options.clock ?? (() => new Date());
   }

   /** The workspace an autopilot belongs to, for a route that only has its id. */
   async workspaceOf(autopilotId: string): Promise<string> {
      const [row] = await this.#sql`SELECT workspace_id FROM autopilots WHERE id = ${autopilotId}`;
      if (!row) throw new NotFound();
      return row.workspace_id as string;
   }

   async list(workspaceId: string): Promise<Autopilot[]> {
      const rows = await this.#sql`
         SELECT a.*, ${this.#sql.unsafe(TRIGGER_KINDS)} FROM autopilots AS a
          WHERE a.workspace_id = ${workspaceId} AND a.archived_at IS NULL
          ORDER BY a.updated_at DESC, a.id DESC
          LIMIT 500`;
      return rows.map(toAutopilot);
   }

   async get(workspaceId: string, autopilotId: string): Promise<Autopilot> {
      const [row] = await this.#sql`
         SELECT a.*, ${this.#sql.unsafe(TRIGGER_KINDS)} FROM autopilots AS a
          WHERE a.workspace_id = ${workspaceId} AND a.id = ${autopilotId}`;
      if (!row) throw new NotFound();
      return toAutopilot(row);
   }

   async create(workspaceId: string, draft: AutopilotDraft, actorId: string): Promise<Autopilot> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await validateDraft(tx, workspaceId, draft);
         const [row] = await tx`
            INSERT INTO autopilots (
               workspace_id, name, description, assignee_type, assignee_id, prompt_template,
               execution_mode, board_id, issue_id, quota_period, quota_max, created_by,
               created_at, updated_at
            ) VALUES (
               ${workspaceId}, ${draft.name}, ${draft.description}, ${draft.assigneeType},
               ${draft.assigneeId}, ${draft.promptTemplate}, ${draft.executionMode},
               ${draft.boardId}, ${draft.issueId}, ${draft.quotaPeriod}, ${draft.quotaMax},
               ${actorId}, ${now}, ${now}
            ) RETURNING *`;
         if (!row) throw new Error('autopilot insert returned no row');
         const autopilot = toAutopilot(row);
         await writeVersion(tx, autopilot, actorId, now);
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.created',
            autopilotId: autopilot.id,
            payload: { name: autopilot.name, version: autopilot.version },
            occurredAt: now,
         });
         return autopilot;
      }) as Promise<Autopilot>;
   }

   /**
    * A definition change and a status change in one call.
    *
    * Only the definition bumps the version: pausing is an operating decision,
    * not a new rule, and the versions list is a history of what the
    * autopilot was told to do.
    */
   async update(
      workspaceId: string,
      autopilotId: string,
      patch: AutopilotPatch,
      actorId: string
   ): Promise<Autopilot> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [locked] = await tx`
            SELECT * FROM autopilots
             WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
             FOR UPDATE`;
         if (!locked) throw new NotFound();
         const current = toAutopilot(locked);
         const before = draftOf(current);
         const next: AutopilotDraft = {
            name: patch.name ?? before.name,
            description: patch.description === undefined ? before.description : patch.description,
            assigneeType: patch.assigneeType ?? before.assigneeType,
            assigneeId: patch.assigneeId ?? before.assigneeId,
            promptTemplate: patch.promptTemplate ?? before.promptTemplate,
            executionMode: patch.executionMode ?? before.executionMode,
            boardId: patch.boardId === undefined ? before.boardId : patch.boardId,
            issueId: patch.issueId === undefined ? before.issueId : patch.issueId,
            quotaPeriod: patch.quotaPeriod ?? before.quotaPeriod,
            quotaMax: patch.quotaMax === undefined ? before.quotaMax : patch.quotaMax,
         };
         const changed = JSON.stringify(next) !== JSON.stringify(before);
         if (changed) await validateDraft(tx, workspaceId, next);
         const status = patch.status ?? current.status;
         const version = changed ? current.version + 1 : current.version;

         const [row] = await tx`
            UPDATE autopilots
               SET name = ${next.name}, description = ${next.description},
                   assignee_type = ${next.assigneeType}, assignee_id = ${next.assigneeId},
                   prompt_template = ${next.promptTemplate}, execution_mode = ${next.executionMode},
                   board_id = ${next.boardId}, issue_id = ${next.issueId},
                   quota_period = ${next.quotaPeriod}, quota_max = ${next.quotaMax},
                   status = ${status}, version = ${version}, updated_at = ${now}
             WHERE id = ${autopilotId}
             RETURNING *`;
         if (!row) throw new NotFound();
         const updated = toAutopilot(row);
         if (changed) await writeVersion(tx, updated, actorId, now);
         // Resuming starts the schedule from now. Without this, every slot
         // that passed while paused would look due, and the first tick after
         // resume would fire one of them as if it were on time.
         if (current.status === 'paused' && status === 'active') {
            await rescheduleCron(tx, autopilotId, new Date(now));
         }
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.updated',
            autopilotId,
            payload: { version, status },
            occurredAt: now,
         });
         return updated;
      }) as Promise<Autopilot>;
   }

   async archive(workspaceId: string, autopilotId: string, actorId: string): Promise<void> {
      const now = this.#clock().toISOString();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            UPDATE autopilots SET status = 'archived', archived_at = ${now}, updated_at = ${now}
             WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
             RETURNING id`;
         if (!row) throw new NotFound();
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.archived',
            autopilotId,
            payload: { archivedBy: actorId },
            occurredAt: now,
         });
      });
   }

   async versions(workspaceId: string, autopilotId: string): Promise<AutopilotVersion[]> {
      await this.get(workspaceId, autopilotId);
      const rows = await this.#sql`
         SELECT version, snapshot, created_by, created_at FROM autopilot_versions
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY version DESC`;
      return rows.map((row) => ({
         version: row.version as number,
         snapshot: row.snapshot as AutopilotDraft,
         createdBy: (row.created_by as string | null) ?? null,
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   async members(workspaceId: string, autopilotId: string): Promise<AutopilotMember[]> {
      const rows = await this.#sql`
         SELECT user_id, role, created_at FROM autopilot_members
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY created_at, user_id`;
      return rows.map(toMember);
   }

   /** Replaces the whole list: the settings form edits it as one thing. */
   async setMembers(
      workspaceId: string,
      autopilotId: string,
      members: { userId: string; role: MemberRole }[]
   ): Promise<AutopilotMember[]> {
      const byUser = new Map(members.map((member) => [member.userId, member.role]));
      const ids = [...byUser.keys()];
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         if (ids.length > 0) {
            const found = await tx`
               SELECT user_id FROM workspace_memberships
                WHERE workspace_id = ${workspaceId} AND user_id = ANY(${ids}::uuid[])`;
            if (found.length !== ids.length) {
               throw new InvalidAutopilot('/members', 'Every member must belong to this workspace.');
            }
         }
         await tx`DELETE FROM autopilot_members WHERE autopilot_id = ${autopilotId}`;
         for (const [userId, role] of byUser) {
            await tx`
               INSERT INTO autopilot_members (workspace_id, autopilot_id, user_id, role)
               VALUES (${workspaceId}, ${autopilotId}, ${userId}, ${role})`;
         }
         const rows = await tx`
            SELECT user_id, role, created_at FROM autopilot_members
             WHERE autopilot_id = ${autopilotId} ORDER BY created_at, user_id`;
         return rows.map(toMember);
      }) as Promise<AutopilotMember[]>;
   }

   async triggers(workspaceId: string, autopilotId: string): Promise<AutopilotTrigger[]> {
      const rows = await this.#sql`
         SELECT * FROM autopilot_triggers
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY created_at, id`;
      return rows.map(toTrigger);
   }

   async addCronTrigger(
      workspaceId: string,
      autopilotId: string,
      input: { expression: string; timezone: string; enabled: boolean }
   ): Promise<AutopilotTrigger> {
      const expression = input.expression.trim();
      assertSchedule(expression, input.timezone);
      const next = input.enabled ? nextFireAfter(expression, input.timezone, this.#clock()) : null;
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         const [row] = await tx`
            INSERT INTO autopilot_triggers (
               workspace_id, autopilot_id, kind, enabled, cron_expression, timezone, next_fire_at
            ) VALUES (
               ${workspaceId}, ${autopilotId}, 'cron', ${input.enabled}, ${expression},
               ${input.timezone}, ${next ? next.toISOString() : null}
            ) RETURNING *`;
         if (!row) throw new Error('trigger insert returned no row');
         return toTrigger(row);
      }) as Promise<AutopilotTrigger>;
   }

   async addWebhookTrigger(
      workspaceId: string,
      autopilotId: string,
      input: { eventFilters: string[]; enabled: boolean }
   ): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
      const secrets = { token: newWebhookToken(), signingSecret: newSigningSecret() };
      // Sealed before anything is written: a server with no key refuses here
      // (SealingUnavailable) rather than after a half-made trigger exists.
      const sealed = this.#sealer.seal(secrets.signingSecret);
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         const [row] = await tx`
            INSERT INTO autopilot_triggers (
               workspace_id, autopilot_id, kind, enabled, webhook_token_hash,
               webhook_token_hint, signing_secret_sealed, event_filters
            ) VALUES (
               ${workspaceId}, ${autopilotId}, 'webhook', ${input.enabled},
               ${hashToken(secrets.token)}, ${tokenHint(secrets.token)}, ${sealed},
               ${input.eventFilters}::text[]
            ) RETURNING *`;
         if (!row) throw new Error('trigger insert returned no row');
         return { trigger: toTrigger(row), secrets };
      }) as Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }>;
   }

   async updateTrigger(
      workspaceId: string,
      autopilotId: string,
      triggerId: string,
      patch: TriggerPatch
   ): Promise<AutopilotTrigger> {
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [locked] = await tx`
            SELECT * FROM autopilot_triggers
             WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${triggerId}
             FOR UPDATE`;
         if (!locked) throw new NotFound();
         const current = toTrigger(locked);
         const enabled = patch.enabled ?? current.enabled;

         if (current.kind === 'cron') {
            if (patch.eventFilters !== undefined) {
               throw new InvalidAutopilot('/eventFilters', 'A schedule has no event filters.');
            }
            const expression = (patch.expression ?? current.cronExpression ?? '').trim();
            const timezone = patch.timezone ?? current.timezone ?? 'UTC';
            assertSchedule(expression, timezone);
            const next = enabled ? nextFireAfter(expression, timezone, this.#clock()) : null;
            const [row] = await tx`
               UPDATE autopilot_triggers
                  SET enabled = ${enabled}, cron_expression = ${expression}, timezone = ${timezone},
                      next_fire_at = ${next ? next.toISOString() : null}
                WHERE id = ${triggerId} RETURNING *`;
            if (!row) throw new NotFound();
            return toTrigger(row);
         }

         if (patch.expression !== undefined || patch.timezone !== undefined) {
            throw new InvalidAutopilot('/expression', 'A webhook has no schedule.');
         }
         const [row] = await tx`
            UPDATE autopilot_triggers
               SET enabled = ${enabled},
                   event_filters = ${patch.eventFilters ?? current.eventFilters}::text[]
             WHERE id = ${triggerId} RETURNING *`;
         if (!row) throw new NotFound();
         return toTrigger(row);
      }) as Promise<AutopilotTrigger>;
   }

   /** New token and new secret together: a leaked URL and a leaked secret are the same incident. */
   async rotateWebhook(
      workspaceId: string,
      autopilotId: string,
      triggerId: string
   ): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
      const secrets = { token: newWebhookToken(), signingSecret: newSigningSecret() };
      const sealed = this.#sealer.seal(secrets.signingSecret);
      const [row] = await this.#sql`
         UPDATE autopilot_triggers
            SET webhook_token_hash = ${hashToken(secrets.token)},
                webhook_token_hint = ${tokenHint(secrets.token)},
                signing_secret_sealed = ${sealed}
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
            AND id = ${triggerId} AND kind = 'webhook'
          RETURNING *`;
      if (!row) throw new NotFound();
      return { trigger: toTrigger(row), secrets };
   }

   async deleteTrigger(workspaceId: string, autopilotId: string, triggerId: string): Promise<void> {
      const rows = await this.#sql`
         DELETE FROM autopilot_triggers
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${triggerId}
          RETURNING id`;
      if (rows.length === 0) throw new NotFound();
   }

   async runs(workspaceId: string, autopilotId: string): Promise<AutopilotRunRecord[]> {
      const rows = await this.#sql`
         SELECT ar.*, r.status AS task_status
           FROM autopilot_runs AS ar
           LEFT JOIN runs AS r ON r.id = ar.run_id
          WHERE ar.workspace_id = ${workspaceId} AND ar.autopilot_id = ${autopilotId}
          ORDER BY ar.created_at DESC, ar.id DESC
          LIMIT ${HISTORY_LIMIT}`;
      return rows.map(toRun);
   }

   async deliveries(workspaceId: string, autopilotId: string): Promise<WebhookDeliveryRecord[]> {
      const rows = await this.#sql`
         SELECT id, autopilot_id, trigger_id, event, status, failure_reason,
                autopilot_run_id, replay_of, received_at
           FROM webhook_deliveries
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY received_at DESC, id DESC
          LIMIT ${HISTORY_LIMIT}`;
      return rows.map(toDelivery);
   }

   async deliveryPayload(
      workspaceId: string,
      autopilotId: string,
      deliveryId: string
   ): Promise<{ delivery: WebhookDeliveryRecord; payload: unknown }> {
      const [row] = await this.#sql`
         SELECT * FROM webhook_deliveries
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${deliveryId}`;
      if (!row) throw new NotFound();
      return { delivery: toDelivery(row), payload: row.payload ?? null };
   }

   /**
    * The trigger a public webhook URL names, with its secret opened.
    *
    * Deliberately not scoped by workspace: the token is the only thing the
    * caller has, and it identifies exactly one trigger by its hash.
    */
   async webhookByToken(
      token: string
   ): Promise<{ trigger: AutopilotTrigger; workspaceId: string; signingSecret: string } | null> {
      const [row] = await this.#sql`
         SELECT * FROM autopilot_triggers
          WHERE webhook_token_hash = ${hashToken(token)} AND kind = 'webhook'`;
      if (!row) return null;
      const signingSecret = this.#sealer.open(Buffer.from(row.signing_secret_sealed as Buffer));
      return { trigger: toTrigger(row), workspaceId: row.workspace_id as string, signingSecret };
   }

   async recordDelivery(input: {
      workspaceId: string;
      autopilotId: string;
      triggerId: string | null;
      event: string | null;
      status: DeliveryStatus;
      payload: unknown;
      failureReason: string | null;
      replayOf: string | null;
   }): Promise<string> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            INSERT INTO webhook_deliveries (
               workspace_id, autopilot_id, trigger_id, event, status, payload,
               failure_reason, replay_of, received_at
            ) VALUES (
               ${input.workspaceId}, ${input.autopilotId}, ${input.triggerId},
               ${input.event === null ? null : input.event.slice(0, 100)}, ${input.status},
               ${input.payload === null || input.payload === undefined ? null : tx.json(input.payload as never)},
               ${input.failureReason}, ${input.replayOf}, ${now}
            ) RETURNING id`;
         if (!row) throw new Error('delivery insert returned no row');
         await writeAutopilotEvent(tx, {
            workspaceId: input.workspaceId,
            topic: 'autopilot.delivery.received',
            autopilotId: input.autopilotId,
            payload: { deliveryId: row.id as string, status: input.status },
            occurredAt: now,
         });
         return row.id as string;
      }) as Promise<string>;
   }

   /**
    * Settles a delivery and points it at the run its firing produced.
    *
    * The run is linked only if its record exists. `fire` is injected, and a
    * delivery must still settle its status when the id it was handed names
    * no autopilot_runs row, rather than failing on the foreign key.
    */
   async linkDelivery(deliveryId: string, autopilotRunId: string | null, status: DeliveryStatus): Promise<void> {
      await this.#sql`
         UPDATE webhook_deliveries
            SET autopilot_run_id = (SELECT id FROM autopilot_runs WHERE id = ${autopilotRunId}),
                status = ${status}
          WHERE id = ${deliveryId}`;
   }
}

async function lockOwned(tx: Sql, workspaceId: string, autopilotId: string): Promise<void> {
   const [row] = await tx`
      SELECT id FROM autopilots
       WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
       FOR UPDATE`;
   if (!row) throw new NotFound();
}

/**
 * The checks a CHECK constraint cannot make: that the agent, squad, board or
 * task named belongs to this workspace. A foreign key would accept one from
 * any workspace.
 */
async function validateDraft(tx: Sql, workspaceId: string, draft: AutopilotDraft): Promise<void> {
   if (draft.assigneeType === 'agent') {
      const [agent] = await tx`
         SELECT 1 FROM agents
          WHERE id = ${draft.assigneeId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (!agent) throw new InvalidAutopilot('/assigneeId', 'That agent is not in this workspace.');
   } else {
      // Squads are workstream D's table. Asked about by name first, so a
      // server without it answers a validation error rather than a 500.
      const [table] = await tx`SELECT to_regclass('public.squads') IS NOT NULL AS present`;
      if (!table?.present) {
         throw new InvalidAutopilot('/assigneeType', 'Squads are not available on this server yet.');
      }
      const [squad] = await tx`
         SELECT 1 FROM squads
          WHERE id = ${draft.assigneeId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (!squad) throw new InvalidAutopilot('/assigneeId', 'That squad is not in this workspace.');
   }

   if (draft.executionMode === 'create_issue') {
      if (!draft.boardId || draft.issueId) {
         throw new InvalidAutopilot(
            '/boardId',
            'An autopilot that opens a task per run needs a board, and no fixed task.'
         );
      }
      const [board] = await tx`
         SELECT 1 FROM boards WHERE id = ${draft.boardId} AND workspace_id = ${workspaceId}`;
      if (!board) throw new InvalidAutopilot('/boardId', 'That board is not in this workspace.');
   } else {
      if (!draft.issueId || draft.boardId) {
         throw new InvalidAutopilot(
            '/issueId',
            'An autopilot that works on one task needs that task, and no board.'
         );
      }
      const [issue] = await tx`
         SELECT 1 FROM issues AS issue JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${draft.issueId} AND board.workspace_id = ${workspaceId}
            AND issue.deleted_at IS NULL`;
      if (!issue) throw new InvalidAutopilot('/issueId', 'That task is not in this workspace.');
   }

   if ((draft.quotaPeriod === 'none') !== (draft.quotaMax === null)) {
      throw new InvalidAutopilot('/quotaMax', 'A quota needs both a period and a limit.');
   }
}

async function writeVersion(tx: Sql, autopilot: Autopilot, actorId: string, now: string): Promise<void> {
   await tx`
      INSERT INTO autopilot_versions (workspace_id, autopilot_id, version, snapshot, created_by, created_at)
      VALUES (${autopilot.workspaceId}, ${autopilot.id}, ${autopilot.version},
              ${tx.json(draftOf(autopilot) as never)}, ${actorId}, ${now})`;
}

async function rescheduleCron(tx: Sql, autopilotId: string, now: Date): Promise<void> {
   const rows = await tx`
      SELECT id, cron_expression, timezone FROM autopilot_triggers
       WHERE autopilot_id = ${autopilotId} AND kind = 'cron' AND enabled`;
   for (const row of rows) {
      const next = nextFireAfter(row.cron_expression as string, row.timezone as string, now);
      await tx`
         UPDATE autopilot_triggers SET next_fire_at = ${next ? next.toISOString() : null}
          WHERE id = ${row.id as string}`;
   }
}

function draftOf(autopilot: Autopilot): AutopilotDraft {
   return {
      name: autopilot.name,
      description: autopilot.description,
      assigneeType: autopilot.assigneeType,
      assigneeId: autopilot.assigneeId,
      promptTemplate: autopilot.promptTemplate,
      executionMode: autopilot.executionMode,
      boardId: autopilot.boardId,
      issueId: autopilot.issueId,
      quotaPeriod: autopilot.quotaPeriod,
      quotaMax: autopilot.quotaMax,
   };
}

/**
 * The distinct kinds of trigger an autopilot has, as a column.
 *
 * Unsafe-interpolated into two reads that already name their workspace in the
 * WHERE clause; it carries no request value of its own, only the row's own id.
 */
const TRIGGER_KINDS = `COALESCE((SELECT array_agg(DISTINCT t.kind)
     FROM autopilot_triggers t WHERE t.autopilot_id = a.id), '{}') AS trigger_kinds`;

function toAutopilot(row: Row): Autopilot {
   return {
      triggerKinds: ((row.trigger_kinds as string[] | null) ?? []) as Array<'cron' | 'webhook'>,
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      assigneeType: row.assignee_type as AssigneeType,
      assigneeId: row.assignee_id as string,
      promptTemplate: row.prompt_template as string,
      executionMode: row.execution_mode as ExecutionMode,
      boardId: (row.board_id as string | null) ?? null,
      issueId: (row.issue_id as string | null) ?? null,
      status: row.status as AutopilotStatus,
      version: row.version as number,
      quotaPeriod: row.quota_period as QuotaPeriod,
      quotaMax: (row.quota_max as number | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function toTrigger(row: Row): AutopilotTrigger {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      kind: row.kind as 'cron' | 'webhook',
      enabled: row.enabled as boolean,
      cronExpression: (row.cron_expression as string | null) ?? null,
      timezone: (row.timezone as string | null) ?? null,
      nextFireAt: toRFC3339(row.next_fire_at as string | null),
      lastFiredAt: toRFC3339(row.last_fired_at as string | null),
      tokenHint: (row.webhook_token_hint as string | null) ?? null,
      eventFilters: (row.event_filters as string[] | null) ?? [],
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function toMember(row: Row): AutopilotMember {
   return {
      userId: row.user_id as string,
      role: row.role as MemberRole,
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}

function toRun(row: Row): AutopilotRunRecord {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      autopilotVersion: row.autopilot_version as number,
      triggerId: (row.trigger_id as string | null) ?? null,
      source: row.source as RunSource,
      status: row.status as RunStatus,
      reasonCode: (row.reason_code as string | null) ?? null,
      reasonMessage: (row.reason_message as string | null) ?? null,
      issueId: (row.issue_id as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      taskStatus: (row.task_status as string | null) ?? null,
      slot: toRFC3339(row.slot as string | null),
      requestedBy: (row.requested_by as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}

function toDelivery(row: Row): WebhookDeliveryRecord {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      triggerId: (row.trigger_id as string | null) ?? null,
      event: (row.event as string | null) ?? null,
      status: row.status as DeliveryStatus,
      failureReason: (row.failure_reason as string | null) ?? null,
      autopilotRunId: (row.autopilot_run_id as string | null) ?? null,
      replayOf: (row.replay_of as string | null) ?? null,
      receivedAt: toRFC3339(row.received_at as string) ?? '',
   };
}
