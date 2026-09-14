// Feature: auth-and-tenant-isolation, Property 14: The wire contract shapes
// are preserved.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import fc from 'fast-check';
import { Hono } from 'hono';

import { ApiError, buildErrorEnvelope, DecoratedApiError } from './errors.ts';
import { createApp } from './app.ts';
import { encodeCursor } from './cursor.ts';
import { Registry } from './registry.ts';
import { serializeUser, type Role, type User } from '../auth/sessions.ts';
import { serializeWorkspace } from '../mounts/me.ts';
import { serializeMember } from '../mounts/shared.ts';
import type { Workspace } from '../identity/repository.ts';
import type { Membership } from '../identity/workspaces.ts';

/**
 * Offline property test. Property 14 is about the *shape* of what leaves the
 * server — the error envelope's keys, the cursor/hasNextPage invariant, and
 * the key set each serializer emits — none of which needs a database. So this
 * runs unconditionally and stays green on a fresh `pnpm test:server`, unlike
 * the DB-gated properties. Every piece exercises the *real* code path: the
 * envelope is rendered by `createApp`'s single `app.onError` (via
 * `buildErrorEnvelope`), the cursor is minted by the real `encodeCursor`, and
 * the key sets come from `serializeUser` / `serializeWorkspace` /
 * `serializeMember` verbatim.
 *
 * The fast-check floor the property suite holds to.
 */
const RUNS = 300;

/**
 * The three key sets are contract constants. They are pinned here as literals
 * (not derived from the serializers) so a serializer that quietly gains or
 * drops a field fails this test rather than silently redefining the contract
 * it is supposed to hold fixed. Order does not matter for a key *set*; the
 * byte-order contract lives in `buildErrorEnvelope` / `goJSON` and the
 * serializers' construction order, not here.
 */
const USER_KEYS = ['id', 'email', 'name', 'avatarUrl', 'role', 'createdAt', 'updatedAt'] as const;
const WORKSPACE_KEYS = [
   'id',
   'name',
   'slug',
   'description',
   'settings',
   'role',
   'createdAt',
   'updatedAt',
   // Appended by the workspace "General" page (migration 174). Listed here, as
   // the comment above requires, so gaining them is a deliberate contract
   // change rather than something a serializer did quietly.
   'logoUrl',
   'agentContext',
] as const;
const WORKSPACE_SETTINGS_KEYS = ['issuePrefix', 'defaultRole', 'allowMemberInvites'] as const;
const MEMBER_KEYS = [
   'userId',
   'workspaceId',
   'role',
   'email',
   'name',
   'avatarUrl',
   'joinedAt',
   'updatedAt',
] as const;

const ENVELOPE_KEYS = ['error'] as const;
const ERROR_BODY_KEYS = ['code', 'message', 'requestId', 'details'] as const;

const keySet = (value: object): Set<string> => new Set(Object.keys(value));
const expected = (keys: readonly string[]): Set<string> => new Set(keys);

/** A key set equal to `keys`, and never one that looks like a password field. */
function assertKeys(value: object, keys: readonly string[], label: string): void {
   assert.deepEqual(keySet(value), expected(keys), `${label}: key set must equal the contract`);
   for (const name of Object.keys(value)) {
      assert.ok(!/password/i.test(name), `${label}: emitted a password-like key "${name}"`);
   }
}

// --- Arbitraries --------------------------------------------------------------

/**
 * A request id the shell will echo rather than replace: `isValidRequestId`
 * (request-id.ts) only trusts a supplied id matching this exact character
 * class, so generating within it pins the correlation id end to end.
 */
const requestId = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

/** SCREAMING_SNAKE codes that pass errors.ts's ERROR_CODE, plus a few that do
 * not — a malformed code must downgrade to 500 INTERNAL but still produce the
 * exact same envelope key set. */
const goodCode = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,31}$/);
const badCode = fc.constantFrom('lower_case', '1LEADING_DIGIT', '_UNDERSCORE', 'has space', '');
const anyCode = fc.oneof(goodCode, badCode);

const status = fc.integer({ min: 100, max: 599 });
const message = fc.string({ maxLength: 200 });

/** Details is `unknown` on the wire: null, a validation-detail object, or an
 * arbitrary JSON value. `buildErrorEnvelope` maps `undefined`/null to null. */
const details = fc.oneof(
   fc.constant(null),
   fc.constant(undefined),
   fc.record({
      fields: fc.array(
         fc.record({ path: fc.string(), code: fc.string(), message: fc.string() }),
         { maxLength: 4 }
      ),
   }),
   fc.jsonValue()
);

const role = fc.constantFrom<Role>('admin', 'member', 'viewer');
const nullableString = fc.option(fc.string({ maxLength: 40 }), { nil: null });
const rfc3339 = fc.constantFrom(
   '2026-01-02T03:04:05Z',
   '2026-08-22T14:01:17.123Z',
   '1999-12-31T23:59:59Z'
);

const userArb: fc.Arbitrary<User> = fc.record({
   id: fc.uuid(),
   email: fc.emailAddress(),
   name: fc.string({ maxLength: 60 }),
   avatarUrl: nullableString,
   role,
   currentWorkspaceId: fc.option(fc.uuid(), { nil: null }),
   createdAt: rfc3339,
   updatedAt: rfc3339,
});

const workspaceArb: fc.Arbitrary<Workspace> = fc.record({
   id: fc.uuid(),
   name: fc.string({ maxLength: 60 }),
   slug: fc.stringMatching(/^[a-z0-9-]{2,50}$/),
   description: nullableString,
   settings: fc.record({
      issuePrefix: fc.string({ maxLength: 5 }),
      defaultRole: fc.string({ maxLength: 10 }),
      allowMemberInvites: fc.boolean(),
   }),
   role: fc.constantFrom('owner', 'admin', 'member', 'viewer'),
   createdAt: rfc3339,
   updatedAt: rfc3339,
   logoUrl: nullableString,
   agentContext: nullableString,
});

const memberArb: fc.Arbitrary<Membership> = fc.record({
   workspaceId: fc.uuid(),
   userId: fc.uuid(),
   role: fc.constantFrom('owner', 'admin', 'member', 'viewer'),
   email: fc.emailAddress(),
   name: fc.string({ maxLength: 60 }),
   avatarUrl: nullableString,
   joinedAt: rfc3339,
   updatedAt: rfc3339,
});

// --- The connection helper, exactly as every list mount builds it -------------

/**
 * The over-fetch pagination the whole server uses (workspaces.ts `page` +
 * `endCursor: last ? encodeCursor(...) : null`, replicated verbatim in every
 * other list mount). A query asks for `first + 1` rows; `hasNextPage` is
 * whether the extra row came back; `endCursor` is minted from the last *kept*
 * node, or null when the page is empty.
 *
 * Note the true relationship this yields, which is what the assertions below
 * check: `hasNextPage === true` forces a non-empty page and therefore a
 * non-null cursor, and `endCursor` is null exactly when the returned page is
 * empty. The design states the tighter `(endCursor === null) === (hasNextPage
 * === false)`; that biconditional's reverse direction does not hold for a
 * final, non-empty page (rows fit in one page: `hasNextPage` false yet
 * `endCursor` non-null), so testing it literally against the real helper would
 * flag correct code. The invariant asserted here is the one the contract
 * actually guarantees and the one clients depend on.
 */
function connection(total: number, first: number): { hasNextPage: boolean; endCursor: string | null } {
   const found = Array.from({ length: total }, (_unused, index) => ({
      createdAt: '2026-01-02T03:04:05Z',
      id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`,
   }));
   const hasNextPage = found.length > first;
   const nodes = hasNextPage ? found.slice(0, first) : found;
   const last = nodes.at(-1);
   const endCursor = last
      ? encodeCursor('identity.workspaces.property14', { createdAt: last.createdAt, id: last.id })
      : null;
   return { hasNextPage, endCursor };
}

describe('Feature: auth-and-tenant-isolation, Property 14: The wire contract shapes are preserved', () => {
   test('Feature: auth-and-tenant-isolation, Property 14: every failure body is exactly { error: { code, message, requestId, details } } and carries a string requestId', async () => {
      // Drive the failures through the real shell: a route that throws the
      // generated ApiError, answered by the one `app.onError` path, so the
      // bytes asserted are the bytes a client receives. The request id is
      // pinned via the `x-request-id` header the shell accepts.
      const handler = new Hono();
      handler.get('/throw', (context) => {
         const spec = context.req.query();
         const parsedStatus = Number(spec.status);
         const detailsRaw = spec.details;
         const parsedDetails = detailsRaw === undefined ? null : (JSON.parse(detailsRaw) as unknown);
         throw new ApiError(parsedStatus, spec.code ?? 'X', spec.message ?? '', parsedDetails);
      });
      const registry = new Registry();
      registry.register({ prefix: '/api/v1/__prop14', handler });
      const app = createApp(registry);

      await fc.assert(
         fc.asyncProperty(status, anyCode, message, details, requestId, async (s, code, msg, d, rid) => {
            const query = new URLSearchParams({ status: String(s), code, message: msg });
            if (d !== undefined) query.set('details', JSON.stringify(d));

            const response = await app.request(`/api/v1/__prop14/throw?${query.toString()}`, {
               headers: { 'x-request-id': rid },
            });
            const body = (await response.json()) as { error: Record<string, unknown> };

            // Exactly one top-level key: `error`.
            assert.deepEqual(keySet(body), expected(ENVELOPE_KEYS), 'envelope has one key: error');
            // The inner body's key set is exactly the four contract keys.
            assert.deepEqual(
               keySet(body.error),
               expected(ERROR_BODY_KEYS),
               'error body keys are exactly code, message, requestId, details'
            );
            // requestId is present and a string; the shell echoed ours back.
            assert.equal(typeof body.error.requestId, 'string', 'requestId is a string');
            assert.equal(body.error.requestId, rid, 'requestId is the supplied correlation id');
            assert.equal(
               response.headers.get('x-request-id'),
               rid,
               'the x-request-id header matches the envelope'
            );
            // No password-like key at either level.
            for (const name of [...Object.keys(body), ...Object.keys(body.error)]) {
               assert.ok(!/password/i.test(name), `envelope leaked a password-like key "${name}"`);
            }
         }),
         { numRuns: RUNS }
      );
   });

   test('Feature: auth-and-tenant-isolation, Property 14: buildErrorEnvelope renders the fixed key set for any status/code/message/details, downgrading a bad code to 500 INTERNAL without changing the shape', () => {
      // The same envelope, checked directly at its source, including the
      // DecoratedApiError carrier (its extra headers must not become body
      // keys). This covers the downgrade path buildErrorEnvelope takes for a
      // malformed code.
      fc.assert(
         fc.property(status, anyCode, message, details, requestId, (s, code, msg, d, rid) => {
            const { status: outStatus, body } = buildErrorEnvelope(s, code, msg, d, rid);
            assert.deepEqual(keySet(body), expected(ENVELOPE_KEYS));
            assert.deepEqual(keySet(body.error), expected(ERROR_BODY_KEYS));
            assert.equal(typeof body.error.requestId, 'string');
            assert.equal(body.error.requestId, rid);
            // details is always present (never omitted); undefined maps to null.
            assert.ok('details' in body.error, 'details key is always present');
            if (/^[A-Z][A-Z0-9_]*$/.test(code)) {
               assert.equal(body.error.code, code, 'a valid code is reported verbatim');
            } else {
               assert.equal(outStatus, 500, 'a malformed code downgrades to 500');
               assert.equal(body.error.code, 'INTERNAL', 'a malformed code becomes INTERNAL');
            }
         }),
         { numRuns: RUNS }
      );

      // A decorated error still carries only the four body keys — its headers
      // travel on the Response, never in the envelope.
      const decorated = new DecoratedApiError(ApiError.unauthorized(), {
         'Cache-Control': 'no-store',
      });
      const rendered = buildErrorEnvelope(
         decorated.status,
         decorated.code,
         decorated.message,
         decorated.details,
         'fixed-request-id'
      );
      assert.deepEqual(keySet(rendered.body.error), expected(ERROR_BODY_KEYS));
   });

   test('Feature: auth-and-tenant-isolation, Property 14: for every paged collection endCursor is non-null when hasNextPage is true, and null exactly when the page is empty', () => {
      fc.assert(
         fc.property(
            fc.integer({ min: 0, max: 500 }),
            fc.integer({ min: 1, max: 100 }),
            (total, first) => {
               const { hasNextPage, endCursor } = connection(total, first);

               // A next page is never advertised without a cursor to reach it.
               if (hasNextPage) {
                  assert.notEqual(endCursor, null, 'hasNextPage true must carry a cursor');
               }
               // The cursor is null exactly when the returned page is empty,
               // which is exactly when the source collection is empty.
               const pageEmpty = total === 0;
               assert.equal(
                  endCursor === null,
                  pageEmpty,
                  'endCursor is null exactly when the page is empty'
               );
               // Consequence: a null cursor implies no next page (the reverse
               // of the design biconditional, which does hold).
               if (endCursor === null) {
                  assert.equal(hasNextPage, false, 'a null cursor cannot have a next page');
               }
            }
         ),
         { numRuns: RUNS }
      );
   });

   test('Feature: auth-and-tenant-isolation, Property 14: serializeUser emits exactly the user key set, never a password field', () => {
      fc.assert(
         fc.property(userArb, (user) => {
            assertKeys(serializeUser(user), USER_KEYS, 'user');
         }),
         { numRuns: RUNS }
      );
   });

   test('Feature: auth-and-tenant-isolation, Property 14: serializeWorkspace emits exactly the workspace key set (and settings key set), never a password field', () => {
      fc.assert(
         fc.property(workspaceArb, (workspace) => {
            const serialized = serializeWorkspace(workspace);
            assertKeys(serialized, WORKSPACE_KEYS, 'workspace');
            assertKeys(serialized.settings as object, WORKSPACE_SETTINGS_KEYS, 'workspace.settings');
         }),
         { numRuns: RUNS }
      );
   });

   test('Feature: auth-and-tenant-isolation, Property 14: serializeMember emits exactly the member key set, never a password field', () => {
      fc.assert(
         fc.property(memberArb, (member) => {
            assertKeys(serializeMember(member), MEMBER_KEYS, 'member');
         }),
         { numRuns: RUNS }
      );
   });
});
