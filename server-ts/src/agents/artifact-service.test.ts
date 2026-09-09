import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { artifactPath, BerryArtifactService, partToBytes } from './artifact-service.ts';
import { InvalidKey, sniffContentType, validateKey, type Storage } from '../storage/storage.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunRepository } from '../runs/repository.ts';
import { RunLedger } from '../runs/ledger.ts';

/**
 * The pure halves of the artifact path. The parts that need PostgreSQL and a
 * bucket were driven against both directly: two agents sharing one run, one
 * writing a file and the other listing, reading and quoting it — which is the
 * handoff a per-agent volume made impossible.
 */

test('a filename passes through, separators and all', () => {
   // ADK JS percent-encodes its own keys rather than refusing separators, and
   // run_artifacts.path permits them, so a nested path survives intact.
   assert.equal(artifactPath('report.md'), 'report.md');
   assert.equal(artifactPath('findings/report.md'), 'findings/report.md');
   assert.equal(artifactPath('src/main/index.ts'), 'src/main/index.ts');
});

test("ADK's user namespace is folded into the path, not dropped", () => {
   // The prefix means "this outlives one session". Discarding it would let a
   // user-scoped file collide with a run-scoped one of the same name.
   assert.equal(artifactPath('user:preferences.json'), 'berry-user/preferences.json');
   assert.notEqual(artifactPath('user:notes.md'), artifactPath('notes.md'));
});

test('a text part is stored as UTF-8 rather than refused', () => {
   // An agent writing a note is the ordinary case; making it base64-encode
   // prose would be a worse interface.
   assert.equal(partToBytes({ text: 'hello' }).toString('utf8'), 'hello');
   assert.equal(partToBytes({ text: 'héllo — em dash' }).toString('utf8'), 'héllo — em dash');
});

test('inline data is decoded from base64', () => {
   const encoded = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
   assert.deepEqual(
      [...partToBytes({ inlineData: { mimeType: 'image/png', data: encoded } })],
      [0x89, 0x50, 0x4e, 0x47]
   );
});

test('a part carrying neither text nor data is refused', () => {
   // Silently writing an empty file would leave a reader with something that
   // looks saved and says nothing.
   assert.throws(() => partToBytes({}), /neither inline data nor text/);
});

test('an unsafe storage key is refused rather than sanitised', () => {
   // A rewritten key points somewhere the caller did not mean, and the caller
   // never finds out.
   for (const key of ['', '../escape', '/absolute', 'back\\slash', 'a//b', 'a/./b', 'a/../b']) {
      assert.throws(() => validateKey(key), InvalidKey, JSON.stringify(key));
   }
   assert.throws(() => validateKey('x'.repeat(1025)), InvalidKey);
   assert.throws(() => validateKey('has\0null'), InvalidKey);
});

test('an ordinary key is accepted and split', () => {
   assert.deepEqual(validateKey('artifacts/ws/run/id'), ['artifacts', 'ws', 'run', 'id']);
});

test('content sniffing recognises what agents produce and admits the rest', () => {
   // A confident wrong guess is worse than an honest unknown, because the
   // browser acts on it.
   assert.equal(sniffContentType(Buffer.from('# heading\n')), 'text/plain; charset=utf-8');
   assert.equal(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
   assert.equal(sniffContentType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
   assert.equal(sniffContentType(Buffer.from('%PDF-1.7')), 'application/pdf');
   assert.equal(sniffContentType(Buffer.from([0x00, 0x01, 0x02])), 'application/octet-stream');
   assert.equal(sniffContentType(Buffer.alloc(0)), 'application/octet-stream');
});

test('tabs and newlines do not make a file binary', () => {
   assert.equal(sniffContentType(Buffer.from('a\tb\nc\r\n')), 'text/plain; charset=utf-8');
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('files across the runs of one task', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let userId = '';
   let workspaceId = '';
   let boardId = '';
   let agentId = '';
   let issueId = '';
   const objects = new Map<string, Uint8Array>();
   const storage = {
      put: async (key: string, body: Uint8Array) => {
         objects.set(key, body);
         return { key, sizeBytes: body.byteLength };
      },
      open: async (key: string) => objects.get(key)!,
      delete: async (key: string) => {
         objects.delete(key);
      },
   } as unknown as Storage;

   before(async () => {
      sql = openDatabase({ url: url! });
      const suffix = randomUUID().slice(0, 8);
      const [user] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`art-${suffix}@berry.test`}, 'Art') RETURNING id`;
      userId = user!.id as string;
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`Art ${suffix}`}, ${`art-${suffix}`},
                 ${sql.json({ issuePrefix: 'AR', defaultRole: 'member', allowMemberInvites: false } as never)}, ${userId})
         RETURNING id`;
      workspaceId = workspace!.id as string;
      await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
      const [board] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, 'Art board', ${`ar-${suffix}`}, ${userId}) RETURNING id`;
      boardId = board!.id as string;
      const [agent] = await sql`
         INSERT INTO agents (id, workspace_id, board_id, name, model_name) VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'maker', 'm') RETURNING id`;
      agentId = agent!.id as string;
      issueId = randomUUID();
      await sql`
         INSERT INTO issues (id, board_id, number, title, status, priority, created_by, assignee_type, assignee_id)
         VALUES (${issueId}, ${boardId}, 1, 'Two attempts', 'todo', 'medium', ${userId}, 'agent', ${agentId})`;
   });

   after(async () => {
      if (!sql) return;
      await sql`DELETE FROM run_artifacts WHERE issue_id = ${issueId}`;
      await sql`DELETE FROM run_events WHERE board_id = ${boardId}`;
      await sql`UPDATE issues SET active_run_id = NULL WHERE id = ${issueId}`;
      await sql`DELETE FROM runs WHERE board_id = ${boardId}`;
      await sql`DELETE FROM issues WHERE id = ${issueId}`;
      await closeDatabase(sql);
   });

   /** A run on the task, finished so the next one can be admitted. */
   async function finishedRun(): Promise<string> {
      const runs = new RunRepository(sql);
      const run = await runs.admit({ issueId, boardId, workspaceId, agentId, requestedBy: userId, instructions: null });
      const ledger = new RunLedger({ sql });
      await ledger.claimDispatch(run.id);
      await ledger.markRunning(run.id);
      await ledger.completeSuccess({ runId: run.id, summary: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicros: null, currency: null } });
      return run.id;
   }

   function service(runId: string, at: Date): BerryArtifactService {
      return new BerryArtifactService({ sql, storage, workspaceId, runId, issueId, agentId, agentName: 'maker', clock: () => at, newId: randomUUID });
   }

   test('a rerun sees what the earlier attempt saved, and its own save becomes the current file', async () => {
      // The prompt tells a rerun that files an earlier attempt saved are
      // still there. Scoped to the run they were not, and a rerun asked to
      // add narration to a clip listed nothing and reported the clip lost.
      const first = service(await finishedRun(), new Date('2026-09-09T10:00:00Z'));
      await first.saveArtifact({ filename: 'video/clip.mp4', artifact: { text: 'clip v1' } });
      await first.saveArtifact({ filename: 'notes.md', artifact: { text: 'notes' } });

      const second = service(await finishedRun(), new Date('2026-09-09T11:00:00Z'));
      assert.deepEqual(await second.listArtifactKeys(), ['notes.md', 'video/clip.mp4']);
      assert.equal(text(await second.loadArtifact({ filename: 'video/clip.mp4' })), 'clip v1');

      await second.saveArtifact({ filename: 'video/clip.mp4', artifact: { text: 'clip v2' } });
      assert.equal(text(await second.loadArtifact({ filename: 'video/clip.mp4' })), 'clip v2', 'the newest write wins');
      assert.equal(text(await first.loadArtifact({ filename: 'video/clip.mp4' })), 'clip v2', 'from any run');
      // A number means something only against the run that allocated it:
      // the rerun's first save is version 0, and so was the first run's.
      assert.equal(text(await first.loadArtifact({ filename: 'video/clip.mp4', version: 0 })), 'clip v1');
      assert.equal(text(await second.loadArtifact({ filename: 'video/clip.mp4', version: 0 })), 'clip v2');
      assert.equal(await second.loadArtifact({ filename: 'video/clip.mp4', version: 1 }), undefined);
   });

   function text(part: { inlineData?: { data: string } | undefined } | undefined): string | undefined {
      return part?.inlineData ? Buffer.from(part.inlineData.data, 'base64').toString('utf8') : undefined;
   }
});
