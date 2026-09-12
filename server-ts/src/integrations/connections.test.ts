import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { ConnectionRepository } from './connections.ts';
import type { Sealer } from './sealing.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * What a reader is told about a connection, against a real database.
 *
 * Real SQL because the thing under test is a row's status disagreeing with its
 * own `expires_at`, and a fake would agree with whatever the code said.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

/** Enough of a sealer to store a row; no test here opens a token. */
const sealer: Sealer = {
   seal: (plaintext) => Buffer.from(plaintext, 'utf8'),
   open: (sealed) => sealed.toString('utf8'),
};

describe(
   'what a reader is told about a connection',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let workspaceId = '';
      let userId = '';
      const now = new Date('2026-09-02T00:00:00.000Z');

      before(async () => {
         sql = openDatabase({ url: url! });
         const suffix = randomUUID().slice(0, 8);
         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`conn-${suffix}@berry.test`}, 'Conn') RETURNING id`;
         userId = user!.id as string;
         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Conn ${suffix}`}, ${`conn-${suffix}`},
                    ${sql.json({ issuePrefix: 'CON', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${userId})
            RETURNING id`;
         workspaceId = workspace!.id as string;
      });

      after(async () => {
         if (!sql) return;
         // A new workspace is seeded with agents whose foreign key does not
         // cascade, and the orchestrator is protected against both deletion and
         // unprotection — so the trigger comes off the way the other database
         // tests take it off, and goes straight back on.
         if (workspaceId) {
            await sql`DELETE FROM integration_connections WHERE workspace_id = ${workspaceId}`;
            await deleteWorkspaceAgents(sql, [workspaceId]);
            await deleteWorkspaceBoards(sql, [workspaceId]);
            await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
         }
         if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      /** A row that still says `connected` long after its credential lapsed. */
      async function connectionExpiring(at: string, provider: string): Promise<void> {
         await sql`
            INSERT INTO integration_connections
                   (id, workspace_id, provider, connected_by_user_id,
                    access_token_encrypted, expires_at, scopes, metadata, status)
            VALUES (${randomUUID()}, ${workspaceId}, ${provider}, ${userId},
                    ${sealer.seal('token')}, ${at}, ${sql.array([] as string[])},
                    ${sql.json({} as never)}, 'connected')`;
      }

      function repository(): ConnectionRepository {
         return new ConnectionRepository({ sql, sealer, clock: () => now });
      }

      test('a lapsed credential reads as expired, whatever the column says', async () => {
         await connectionExpiring('2026-08-25T18:47:46Z', 'github');
         const connection = await repository().find(workspaceId, 'github');

         assert.equal(connection?.status, 'expired');
         assert.match(connection?.statusDetail ?? '', /Reconnect/);
      });

      test('a credential with time left is left alone', async () => {
         await connectionExpiring('2026-09-03T00:00:00Z', 'slack');
         const connection = await repository().find(workspaceId, 'slack');

         assert.equal(connection?.status, 'connected');
         assert.equal(connection?.statusDetail, null);
      });

      test('the list agrees with the single read', async () => {
         const listed = await repository().list(workspaceId);
         const byProvider = new Map(listed.map((row) => [row.provider, row.status]));

         assert.equal(byProvider.get('github'), 'expired');
         assert.equal(byProvider.get('slack'), 'connected');
      });
   }
);
