import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import {
   DEFAULT_GITHUB_SETTINGS,
   GitHubSettingsRepository,
   normaliseRepositoryUrl,
} from './github-settings.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

describe('what counts as a repository URL', () => {
   test('https, ssh and scp-style addresses are kept, trimmed and without a trailing slash', () => {
      assert.equal(normaliseRepositoryUrl('  https://github.com/acme/api/ '), 'https://github.com/acme/api');
      assert.equal(normaliseRepositoryUrl('git@github.com:acme/api.git'), 'git@github.com:acme/api.git');
      assert.equal(normaliseRepositoryUrl('ssh://git@github.com/acme/api.git'), 'ssh://git@github.com/acme/api.git');
   });

   test('anything else is refused', () => {
      assert.equal(normaliseRepositoryUrl('http://github.com/acme/api'), null);
      assert.equal(normaliseRepositoryUrl('ftp://example.com/x'), null);
      assert.equal(normaliseRepositoryUrl('acme/api'), null);
      assert.equal(normaliseRepositoryUrl(''), null);
      assert.equal(normaliseRepositoryUrl('https://'), null);
      assert.equal(normaliseRepositoryUrl(`https://github.com/${'a'.repeat(600)}`), null);
      assert.equal(normaliseRepositoryUrl('https://github.com/a b'), null);
   });
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   'GitHub settings and repositories, per workspace',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const workspaceIds: string[] = [];
      let userId = '';

      async function workspace(label: string): Promise<string> {
         const suffix = randomUUID().slice(0, 8);
         const [row] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label.toLowerCase()}-${suffix}`},
                    ${sql.json({ issuePrefix: 'GHS', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${userId})
            RETURNING id`;
         workspaceIds.push(row!.id as string);
         return row!.id as string;
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`ghs-${randomUUID().slice(0, 8)}@berry.test`}, 'Settings')
            RETURNING id`;
         userId = user!.id as string;
      });

      after(async () => {
         if (!sql) return;
         for (const id of workspaceIds) {
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${id}`;
            await deleteWorkspaceAgents(sql, [id]);
            await deleteWorkspaceBoards(sql, [id]);
            await sql`DELETE FROM workspaces WHERE id = ${id}`;
         }
         if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      test('a workspace that never saved settings reads the defaults', async () => {
         const w = await workspace('Defaults');
         const settings = await new GitHubSettingsRepository(sql).get(w);
         assert.deepEqual({ ...settings, updatedAt: null }, DEFAULT_GITHUB_SETTINGS);
      });

      test('an update persists, keeps untouched fields, and publishes one event', async () => {
         const w = await workspace('Update');
         const repository = new GitHubSettingsRepository(sql);
         const saved = await sql.begin((tx) =>
            repository.update(w, { coAuthorTrailer: false }, userId, tx)
         );
         assert.equal(saved.coAuthorTrailer, false);
         assert.equal(saved.enabled, true);
         assert.equal((await repository.get(w)).coAuthorTrailer, false);
         const events = await sql`
            SELECT topic FROM outbox_events WHERE workspace_id = ${w} AND topic = 'github.settings.updated'`;
         assert.equal(events.length, 1);
      });

      test('repositories are listed only for the workspace that added them', async () => {
         const w1 = await workspace('RepoA');
         const w2 = await workspace('RepoB');
         const repository = new GitHubSettingsRepository(sql);
         await sql.begin((tx) =>
            repository.addRepositories(w2, [{ url: 'https://github.com/w2/secret' }], userId, tx)
         );
         const added = await sql.begin((tx) =>
            repository.addRepositories(
               w1,
               [{ url: 'https://github.com/w1/api', description: 'API' }, { url: 'https://github.com/w1/api' }],
               userId,
               tx
            )
         );
         assert.equal(added.length, 1, 'a duplicate URL is added once');
         const listed = await repository.listRepositories(w1);
         assert.deepEqual(listed.map((row) => row.url), ['https://github.com/w1/api']);

         const [foreign] = await repository.listRepositories(w2);
         const crossed = await sql.begin((tx) =>
            repository.updateRepository(w1, foreign!.id, { description: 'hijacked' }, tx)
         );
         assert.equal(crossed, null, 'another workspace’s repository cannot be edited from this one');
         const removed = await sql.begin((tx) => repository.removeRepository(w1, foreign!.id, tx));
         assert.equal(removed, false);
         assert.equal((await repository.listRepositories(w2))[0]?.description, '');
      });
   }
);
