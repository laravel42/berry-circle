import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, buildErrorEnvelope } from './errors.ts';
import { isValidRequestId, newRequestId } from './request-id.ts';

/**
 * The envelope is a public contract, so these assertions are pinned against
 * captured responses rather than transcribed from the code that produces them.
 * A difference here is a difference the browser sees.
 */

/** Captured from `curl http://127.0.0.1:4000/api/v1/issues` on 2026-08-27. */
const GO_UNAUTHENTICATED =
   '{"error":{"code":"UNAUTHENTICATED","message":"Authentication required.","requestId":"REQ","details":null}}';

/** Captured from `curl http://127.0.0.1:4000/api/v1/nope`. */
const GO_ROUTE_NOT_FOUND =
   '{"error":{"code":"NOT_FOUND","message":"Route not found.","requestId":"REQ","details":null}}';

/** Bodies only; the trailing newline Go writes is asserted in app.test.ts. */
function serialize(error: ApiError, requestId = 'REQ'): string {
   const { body } = buildErrorEnvelope(
      error.status,
      error.code,
      error.message,
      error.details,
      requestId
   );
   return JSON.stringify(body);
}

test('an unauthenticated envelope is byte-for-byte what Go sends', () => {
   assert.equal(serialize(ApiError.unauthorized()), GO_UNAUTHENTICATED);
});

test('a route-not-found envelope is byte-for-byte what Go sends', () => {
   assert.equal(serialize(ApiError.routeNotFound()), GO_ROUTE_NOT_FOUND);
});

test('key order matches, because the frontend compares whole bodies in tests', () => {
   const { body } = buildErrorEnvelope(400, 'INVALID_REQUEST', 'Bad.', null, 'REQ');
   assert.deepEqual(Object.keys(body.error), ['code', 'message', 'requestId', 'details']);
});

test('details is null rather than absent when there is nothing to say', () => {
   const serialized = serialize(new ApiError(500, 'INTERNAL', 'Internal server error.'));
   assert.ok(serialized.includes('"details":null'), serialized);
});

test('details survives when a handler supplies field errors', () => {
   const error = ApiError.badRequest('Invalid.', {
      fields: [{ path: '/title', code: 'REQUIRED', message: 'Title is required.' }],
   });
   const parsed = JSON.parse(serialize(error)) as { error: { details: unknown } };
   assert.deepEqual(parsed.error.details, {
      fields: [{ path: '/title', code: 'REQUIRED', message: 'Title is required.' }],
   });
});

test('an invalid code is downgraded to INTERNAL rather than emitted', () => {
   // A typo'd code is a bug in Berry, and a client cannot switch on it, so Go
   // refuses to put it on the wire at all.
   for (const code of ['lowercase', '1LEADING_DIGIT', 'HAS-HYPHEN', '', 'HAS SPACE']) {
      const { status, body } = buildErrorEnvelope(418, code, 'Teapot.', { a: 1 }, 'REQ');
      assert.equal(status, 500, `accepted ${code}`);
      assert.equal(body.error.code, 'INTERNAL');
      assert.equal(body.error.details, null, 'details must not leak past a bad code');
   }
});

test('a valid code is passed through with its status', () => {
   const { status, body } = buildErrorEnvelope(409, 'CONFLICT', 'Clash.', null, 'REQ');
   assert.equal(status, 409);
   assert.equal(body.error.code, 'CONFLICT');
});

test('request ids have the shape Go emits', () => {
   const id = newRequestId();
   assert.match(id, /^req_[0-9a-f]{32}$/);
   assert.notEqual(id, newRequestId());
   assert.ok(isValidRequestId(id));
   assert.ok(!isValidRequestId('has space'));
   assert.ok(!isValidRequestId('a'.repeat(65)));
   assert.ok(!isValidRequestId(undefined));
});
