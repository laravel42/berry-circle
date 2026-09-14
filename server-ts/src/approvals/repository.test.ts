import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import {
   ApprovalRepository,
   ApprovalResolved,
   GateExists,
   NotAddressee,
   toColumnKind,
   toWireKind,
} from './repository.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * The gate.
 *
 * Against a real PostgreSQL, because the thing worth proving is that the
 * database and this code agree: a trigger refuses a gated task's move to
 * `todo`, so if resolution did not release the task the product would have a
 * task nobody could ever start. A fake would happily agree with either.
 *
 * Gated on BERRY_TEST_DATABASE_URL so `npm test` stays runnable without one.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

test('kinds cross the wire camelCase and land snake_case', () => {
   assert.equal(toWireKind('issue_start'), 'issueStart');
   assert.equal(toWireKind('integration_action'), 'integrationAction');
   assert.equal(toWireKind('plan'), 'plan');
   assert.equal(toColumnKind('issueStart'), 'issue_start');
   assert.equal(toColumnKind('plan'), 'plan');
   // Round-trips, which is the property that keeps the trigger's `issue_start`
   // and the contract's `issueStart` from drifting apart.
   for (const kind of ['plan', 'issueStart', 'integrationAction']) {
      assert.equal(toWireKind(toColumnKind(kind)), kind);
   }
});

describe('approval repository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let approvals: ApprovalRepository;
   const fixture = { workspaceId: '', boardId: '', ownerId: '', memberId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      approvals = new ApprovalRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   let issueId = '';
   beforeEach(async () => {
      issueId = await createIssue(sql, fixture);
   });

   test('opening a gate holds the task where a person can see it', async () => {
      const approval = await open(approvals, fixture, issueId);

      assert.equal(approval.kind, 'issueStart');
      assert.equal(approval.status, 'pending');
      // Addressed to admins when nobody was named: a gate with no addressee
      // is one nobody is responsible for.
      assert.equal(approval.requestedFrom.role, 'admin');
      assert.equal(approval.issue?.id, issueId);
      assert.match(approval.issue!.identifier, /^[A-Z]+-\d+$/);

      const [issue] = await sql`SELECT status::text AS status FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.status, 'backlog');
   });

   test('the database refuses to start a gated task, which is the whole point', async () => {
      // Asserted here rather than trusted: if a direct status write could
      // release a task, the gate would be advisory and the product's one hard
      // stop would not be one.
      await open(approvals, fixture, issueId);
      await assert.rejects(
         () => sql`UPDATE issues SET status = 'todo' WHERE id = ${issueId}`,
         /waiting for approval/
      );
   });

   test('a second gate on one task is refused, and names the first', async () => {
      const first = await open(approvals, fixture, issueId);
      await assert.rejects(
         () => open(approvals, fixture, issueId),
         (error: unknown) => {
            assert.ok(error instanceof GateExists);
            assert.equal(error.approvalId, first.id);
            return true;
         }
      );
   });

   test('approving releases the task in the same breath', async () => {
      const approval = await open(approvals, fixture, issueId);
      const resolved = await approvals.resolve({
         approvalId: approval.id,
         decision: 'approved',
         userId: fixture.ownerId!,
         role: 'owner',
         note: 'looks right',
      });

      assert.equal(resolved.status, 'approved');
      assert.equal(resolved.decisionNote, 'looks right');
      assert.equal(resolved.resolvedBy, fixture.ownerId);
      assert.ok(resolved.resolvedAt);

      const [issue] = await sql`SELECT status::text AS status FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.status, 'todo');
   });

   test('a task whose blockers are still open is released to blocked, not todo', async () => {
      // Saying a task is ready to start when it cannot start is a lie the
      // board would show.
      const blocker = await createIssue(sql, fixture);
      await sql`
         INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id, created_by)
         VALUES (${fixture.workspaceId!}, ${issueId}, ${blocker}, ${fixture.ownerId!})`;

      const approval = await open(approvals, fixture, issueId);
      await approvals.resolve({
         approvalId: approval.id,
         decision: 'approved',
         userId: fixture.ownerId!,
         role: 'owner',
         note: null,
      });

      const [issue] = await sql`SELECT status::text AS status FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.status, 'blocked');
   });

   test('rejecting leaves the task held', async () => {
      const approval = await open(approvals, fixture, issueId);
      const resolved = await approvals.resolve({
         approvalId: approval.id,
         decision: 'rejected',
         userId: fixture.ownerId!,
         role: 'owner',
         note: null,
      });

      assert.equal(resolved.status, 'rejected');
      const [issue] = await sql`SELECT status::text AS status FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.status, 'backlog');
   });

   test('a decided gate is decided', async () => {
      const approval = await open(approvals, fixture, issueId);
      const decide = () =>
         approvals.resolve({
            approvalId: approval.id,
            decision: 'approved',
            userId: fixture.ownerId!,
            role: 'owner',
            note: null,
         });
      await decide();
      await assert.rejects(decide, ApprovalResolved);
   });

   test('a gate addressed to one person is not anyone else to answer', async () => {
      const approval = await open(approvals, fixture, issueId, {
         requestedFromUserId: fixture.ownerId!,
      });
      await assert.rejects(
         () =>
            approvals.resolve({
               approvalId: approval.id,
               decision: 'approved',
               userId: fixture.memberId!,
               role: 'member',
               note: null,
            }),
         (error: unknown) => {
            assert.ok(error instanceof NotAddressee);
            assert.equal(error.reason, 'not_addressee');
            return true;
         }
      );
   });

   test('a gate addressed to admins is every admin\'s, and no member\'s', async () => {
      // The reason `mine` means "could decide" rather than "addressed to me":
      // a role-addressed gate would otherwise wait forever.
      const approval = await open(approvals, fixture, issueId);
      await assert.rejects(
         () =>
            approvals.resolve({
               approvalId: approval.id,
               decision: 'approved',
               userId: fixture.memberId!,
               role: 'member',
               note: null,
            }),
         NotAddressee
      );
      const resolved = await approvals.resolve({
         approvalId: approval.id,
         decision: 'approved',
         userId: fixture.ownerId!,
         role: 'owner',
         note: null,
      });
      assert.equal(resolved.status, 'approved');
   });

   test('high risk needs an admin, even from the person it names', async () => {
      // The rule is about what the decision costs, not about whose it is, so
      // being the named addressee does not lift it.
      const approval = await open(approvals, fixture, issueId, {
         risk: 'high',
         requestedFromUserId: fixture.memberId!,
      });
      await assert.rejects(
         () =>
            approvals.resolve({
               approvalId: approval.id,
               decision: 'approved',
               userId: fixture.memberId!,
               role: 'member',
               note: null,
            }),
         (error: unknown) => {
            assert.ok(error instanceof NotAddressee);
            assert.equal(error.reason, 'admin_required');
            return true;
         }
      );
   });

   test('mine is what the caller could decide, not what names them', async () => {
      const toAdmins = await open(approvals, fixture, issueId);
      const toMember = await open(approvals, fixture, await createIssue(sql, fixture), {
         requestedFromUserId: fixture.memberId!,
      });

      const ownerSees = await approvals.list(
         fixture.workspaceId!,
         { mine: { userId: fixture.ownerId!, role: 'owner' } },
         null,
         50
      );
      const memberSees = await approvals.list(
         fixture.workspaceId!,
         { mine: { userId: fixture.memberId!, role: 'member' } },
         null,
         50
      );

      const ownerIds = ownerSees.map((approval) => approval.id);
      const memberIds = memberSees.map((approval) => approval.id);
      assert.ok(ownerIds.includes(toAdmins.id), 'an owner outranks an admin-addressed gate');
      assert.ok(memberIds.includes(toMember.id), 'a member sees the one addressed to them');
      assert.ok(!memberIds.includes(toAdmins.id), 'a member cannot decide an admin-addressed gate');
   });

   test('a high-risk gate is not in a member\'s queue, because they cannot answer it', async () => {
      const risky = await open(approvals, fixture, issueId, {
         risk: 'high',
         requestedFromUserId: fixture.memberId!,
      });
      const memberSees = await approvals.list(
         fixture.workspaceId!,
         { mine: { userId: fixture.memberId!, role: 'member' } },
         null,
         50
      );
      assert.ok(!memberSees.map((approval) => approval.id).includes(risky.id));
   });

   test('a status filter narrows to that status', async () => {
      const decided = await open(approvals, fixture, issueId);
      await approvals.resolve({
         approvalId: decided.id,
         decision: 'rejected',
         userId: fixture.ownerId!,
         role: 'owner',
         note: null,
      });
      const pending = await open(approvals, fixture, await createIssue(sql, fixture));

      const rejected = await approvals.list(fixture.workspaceId!, { status: 'rejected' }, null, 50);
      const ids = rejected.map((approval) => approval.id);
      assert.ok(ids.includes(decided.id));
      assert.ok(!ids.includes(pending.id));
   });

   test('a kind filter takes the column spelling', async () => {
      const gate = await open(approvals, fixture, issueId);
      const found = await approvals.list(
         fixture.workspaceId!,
         { kind: toColumnKind('issueStart') },
         null,
         50
      );
      assert.ok(found.map((approval) => approval.id).includes(gate.id));
   });

   test('paging is stable across a shared timestamp', async () => {
      const created: string[] = [];
      for (let index = 0; index < 3; index += 1) {
         created.push((await open(approvals, fixture, await createIssue(sql, fixture))).id);
      }
      await sql`UPDATE approvals SET requested_at = '2026-02-02T00:00:00Z' WHERE id = ANY(${created})`;
      const expected = [...created].sort().reverse();

      const first = await approvals.list(fixture.workspaceId!, { status: 'pending' }, null, 50);
      const window = first.filter((approval) => created.includes(approval.id));
      assert.deepEqual(
         window.map((approval) => approval.id),
         expected
      );

      const last = window[0]!;
      const rest = await approvals.list(
         fixture.workspaceId!,
         { status: 'pending' },
         { createdAt: last.requestedAt, id: last.id },
         50
      );
      assert.deepEqual(
         rest.filter((approval) => created.includes(approval.id)).map((approval) => approval.id),
         expected.slice(1)
      );
   });

   test('an approval that does not exist is not found', async () => {
      await assert.rejects(() => approvals.get(randomUUID()), NotFound);
   });
});

// ------------------------------------------------------------------ fixture

function open(
   approvals: ApprovalRepository,
   fixture: Record<string, string>,
   issueId: string,
   overrides: { risk?: 'low' | 'medium' | 'high'; requestedFromUserId?: string } = {}
) {
   return approvals.open({
      workspaceId: fixture.workspaceId!,
      issueId,
      title: 'Start this task?',
      description: null,
      risk: overrides.risk ?? 'medium',
      requestedFromUserId: overrides.requestedFromUserId ?? null,
      requestedFromRole: null,
      requestedBy: fixture.ownerId!,
      expiresAt: null,
   });
}

async function createIssue(sql: Sql, fixture: Record<string, string>): Promise<string> {
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId!} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${fixture.boardId!}, ${Number(counter!.issue_counter)},
                 'Gated task', 'todo', ${fixture.ownerId!})`;
   });
   return issueId;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   for (const [key, label] of [
      ['ownerId', 'Owner'],
      ['memberId', 'Member'],
   ] as const) {
      const [user] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`${key}-${suffix}@berry.test`}, ${`Approval ${label}`})
         RETURNING id`;
      fixture[key] = user!.id as string;
   }

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Gates ${suffix}`}, ${`gates-${suffix}`},
              ${sql.json({ issuePrefix: 'GAT', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.ownerId!})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;

   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.ownerId!}, 'owner'),
             (${fixture.workspaceId}, ${fixture.memberId!}, 'member')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Gates board', ${`gat-${suffix}`},
              ${fixture.ownerId!})
      RETURNING id`;
   fixture.boardId = board!.id as string;
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM approvals WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.ownerId!} OR id = ${fixture.memberId!}`;
}
