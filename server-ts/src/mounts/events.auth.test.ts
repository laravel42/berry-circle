import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { ReplayRepository } from '../realtime/replay.ts';
import { SessionService } from '../auth/sessions.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { eventMounts } from './events.ts';

/** The browser's event stream signs in with the session cookie, not a bearer. */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

function build() {
   const sql = (async () => [
      {
         id: USER_ID,
         email: 'ada@berry.test',
         name: 'Ada',
         avatar_url: null,
         role: 'member',
         last_workspace_id: null,
         created_at: '2026-01-01T00:00:00Z',
         updated_at: '2026-01-01T00:00:00Z',
      },
   ]) as unknown as Sql;
   const sessions = new SessionService({
      sql,
      auth: {
         getSession: async ({ headers }) =>
            headers.get('cookie')?.includes('berry.session_token=good')
               ? { user: { id: USER_ID } }
               : null,
      },
   });
   const boards = {
      authorizeWorkspace: async () => undefined,
      authorize: async () => undefined,
   } as unknown as BoardRepository;
   const replay = {
      replay: async () => [],
      resolveCursor: async () => null,
   } as unknown as ReplayRepository;
   const registry = new Registry();
   registry.registerAll(eventMounts({ sessions, replay, boards, pollMs: 10, heartbeatMs: 1000 }));
   return createApp(registry);
}

test('the event stream opens for a session cookie', async () => {
   const response = await build().request(`/api/v1/events?workspaceId=${WORKSPACE}`, {
      headers: { cookie: 'berry.session_token=good', accept: 'text/event-stream' },
   });
   assert.equal(response.status, 200);
   assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
   await response.body?.cancel();
});

test('the event stream refuses a request with no credential', async () => {
   const response = await build().request(`/api/v1/events?workspaceId=${WORKSPACE}`);
   assert.equal(response.status, 401);
});
