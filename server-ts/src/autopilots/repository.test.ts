import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvalidSchedule } from './cron.ts';
import { AutopilotRepository, InvalidAutopilot, type AutopilotDraft } from './repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilot repository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: AutopilotRepository;
   let mine: Fixture;
   let theirs: Fixture;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      mine = await seedWorkspace(sql, 'repo-a');
      theirs = await seedWorkspace(sql, 'repo-b');
   });

   after(async () => {
      await cleanupWorkspace(sql, mine);
      await cleanupWorkspace(sql, theirs);
      await closeDatabase(sql);
   });

   function draft(overrides: Partial<AutopilotDraft> = {}): AutopilotDraft {
      return {
         name: 'Nightly triage',
         description: null,
         assigneeType: 'agent',
         assigneeId: mine.agentId,
         promptTemplate: 'Triage what came in overnight.',
         executionMode: 'create_issue',
         boardId: mine.boardId,
         issueId: null,
         quotaPeriod: 'none',
         quotaMax: null,
         ...overrides,
      };
   }

   test('creating an autopilot records version 1 and announces it', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      assert.equal(created.version, 1);
      assert.equal(created.status, 'active');
      const versions = await repo.versions(mine.workspaceId, created.id);
      assert.deepEqual(versions.map((v) => v.version), [1]);
      assert.equal(versions[0]?.snapshot.promptTemplate, 'Triage what came in overnight.');
      const [event] = await sql`
         SELECT topic FROM outbox_events WHERE aggregate_id = ${created.id} AND topic = 'autopilot.created'`;
      assert.ok(event);
   });

   test('an agent from another workspace cannot be the assignee', async () => {
      await assert.rejects(
         repo.create(mine.workspaceId, draft({ assigneeId: theirs.agentId }), mine.userId),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/assigneeId'
      );
   });

   test('a board from another workspace cannot be the target', async () => {
      await assert.rejects(
         repo.create(mine.workspaceId, draft({ boardId: theirs.boardId }), mine.userId),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/boardId'
      );
   });

   test('changing the prompt is a new version; pausing is not', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const paused = await repo.update(mine.workspaceId, created.id, { status: 'paused' }, mine.userId);
      assert.equal(paused.version, 1);
      assert.equal(paused.status, 'paused');
      const edited = await repo.update(mine.workspaceId, created.id, { promptTemplate: 'New words.' }, mine.userId);
      assert.equal(edited.version, 2);
      const versions = await repo.versions(mine.workspaceId, created.id);
      assert.deepEqual(versions.map((v) => v.version), [2, 1]);
   });

   test('an autopilot is not found through another workspace', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      await assert.rejects(repo.get(theirs.workspaceId, created.id), { name: 'NotFound' });
      assert.equal(await repo.workspaceOf(created.id), mine.workspaceId);
   });

   test('a webhook token is shown once, stored as a hash, and stops working when rotated', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const { trigger, secrets } = await repo.addWebhookTrigger(mine.workspaceId, created.id, {
         eventFilters: ['deploy'],
         enabled: true,
      });
      assert.equal(trigger.tokenHint, secrets.token.slice(-4));
      assert.deepEqual(trigger.eventFilters, ['deploy']);

      const [row] = await sql`
         SELECT webhook_token_hash, signing_secret_sealed FROM autopilot_triggers WHERE id = ${trigger.id}`;
      assert.ok(row);
      assert.equal(Buffer.from(row.webhook_token_hash as Buffer).includes(Buffer.from(secrets.token)), false);
      assert.equal(Buffer.from(row.signing_secret_sealed as Buffer).includes(Buffer.from(secrets.signingSecret)), false);

      const found = await repo.webhookByToken(secrets.token);
      assert.equal(found?.signingSecret, secrets.signingSecret);
      assert.equal(found?.trigger.id, trigger.id);

      const rotated = await repo.rotateWebhook(mine.workspaceId, created.id, trigger.id);
      assert.equal(await repo.webhookByToken(secrets.token), null);
      assert.equal((await repo.webhookByToken(rotated.secrets.token))?.trigger.id, trigger.id);
   });

   test('a cron trigger knows when it fires next, and a bad zone is refused', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const trigger = await repo.addCronTrigger(mine.workspaceId, created.id, {
         expression: '0 9 * * *',
         timezone: 'Europe/Rome',
         enabled: true,
      });
      assert.ok(trigger.nextFireAt && Date.parse(trigger.nextFireAt) > Date.now());
      await assert.rejects(
         repo.addCronTrigger(mine.workspaceId, created.id, {
            expression: '0 9 * * *',
            timezone: 'Nowhere/At_All',
            enabled: true,
         }),
         InvalidSchedule
      );
   });

   test('only workspace members can be collaborators or subscribers', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const members = await repo.setMembers(mine.workspaceId, created.id, [
         { userId: mine.userId, role: 'subscriber' },
      ]);
      assert.deepEqual(members.map((m) => [m.userId, m.role]), [[mine.userId, 'subscriber']]);
      await assert.rejects(
         repo.setMembers(mine.workspaceId, created.id, [{ userId: theirs.userId, role: 'collaborator' }]),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/members'
      );
      await assert.rejects(
         repo.setMembers(mine.workspaceId, created.id, [{ userId: randomUUID(), role: 'collaborator' }]),
         InvalidAutopilot
      );
   });
});
