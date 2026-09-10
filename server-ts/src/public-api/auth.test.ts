import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../auth/sessions.ts';
import { Unauthenticated, generatePersonalToken } from '../auth/tokens.ts';
import type { ApiError } from '../http/errors.ts';
import { generatePluginToken } from '../plugins/tokens.ts';
import { PluginTokenInvalid } from '../plugins/runtime-store.ts';
import { requirePlugin, requireScope, resolvePrincipal, type CredentialDeps } from './auth.ts';

const USER: User = {
   id: '11111111-1111-4111-8111-111111111111', email: 'a@berry.test', name: 'A', avatarUrl: null,
   role: 'member', currentWorkspaceId: null, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
};
const PLUGIN = {
   installationId: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333',
   pluginKey: 'hello', installedBy: USER.id, scopes: ['issues:read' as const],
};
const plugin = generatePluginToken().token;
const pat = generatePersonalToken().token;

const deps: CredentialDeps = {
   personalTokens: { resolve: async (token) => { if (token !== pat) throw new Error('no'); return USER; } },
   plugins: { resolveToken: async (token) => { if (token !== plugin) throw new PluginTokenInvalid(); return PLUGIN; } },
   personalScopes: async () => ['comments:read'],
};

test('a personal token resolves to its user with the scopes stored on it', async () => {
   const principal = await resolvePrincipal(deps, `Bearer ${pat}`);
   assert.equal(principal.kind, 'user');
   assert.deepEqual(principal.scopes, ['comments:read']);
});

test('a plugin token resolves to its installation', async () => {
   const principal = await resolvePrincipal(deps, `Bearer ${plugin}`);
   assert.equal(principal.kind, 'plugin');
   assert.deepEqual(requirePlugin(principal), PLUGIN);
});

test('session tokens, malformed headers and plugin tokens without a store are refused', async () => {
   const session = Buffer.alloc(32, 7).toString('base64url');
   for (const header of [`Bearer ${session}`, `bearer ${pat}`, `Bearer  ${pat}`, `Bearer ${pat} x`, 'Basic abc']) {
      await assert.rejects(resolvePrincipal(deps, header), Unauthenticated, header);
   }
   await assert.rejects(resolvePrincipal({ ...deps, plugins: null }, `Bearer ${plugin}`), Unauthenticated);
});

test('scope and principal checks answer 403 with stable codes', async () => {
   const user = await resolvePrincipal(deps, `Bearer ${pat}`);
   assert.throws(() => requireScope(user, 'issues:write'), (e) => (e as ApiError).code === 'INSUFFICIENT_SCOPE' && (e as ApiError).status === 403);
   assert.throws(() => requirePlugin(user), (e) => (e as ApiError).code === 'PLUGIN_TOKEN_REQUIRED');
   requireScope({ kind: 'user', user: USER, scopes: null }, 'storage:write');
});
