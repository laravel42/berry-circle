import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJSON, parseWithRawNumbers } from './canonical-json.ts';
import { fingerprintJSON, replayHeaders, validateIdempotencyKey } from './idempotency.ts';

/**
 * Captured hashes for these exact bodies.
 *
 * The fingerprint decides whether a retried request replays or is refused as a
 * conflict, and fingerprints of past requests are already stored. A change to
 * the canonical form turns a legitimate retry into an IDEMPOTENCY_CONFLICT.
 */
const GO_FINGERPRINTS: Array<[string, string]> = [
   [String.raw`{"a":1,"b":2}`, '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
   [String.raw`{"b":2,"a":1}`, '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
   [String.raw`{ "a" : 1 , "b" : 2 }`, '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
   [String.raw`{"n":1.0}`, '3b6b06ecd1c968c8e738e0f11c4bb361fca80a9a694de22fe66a05286afbd081'],
   [String.raw`{"n":1e2}`, '477bbdd93b24d7ebe5b110b7bd76f53e82c2831cd361d557779cbf3f1da9c522'],
   [String.raw`{"n":1.50}`, 'cc2502b0dcb47e2f236fb9aa2a83b13dbb185d1104c14b63f224520863bec784'],
   [String.raw`{"big":12345678901234567890}`, 'e0f18f283c09bac46385612a836c6f46ae6fa0eb73626a1a48a1ce157e3cb710'],
   [String.raw`{"s":"a<b>c&d"}`, '04d6cdea3d87cbcf079d82b90f3512cb2bd830d3738f2a7b1ba7abce4fac2db0'],
   [String.raw`{"s":"héllo"}`, 'b5e500b94458334258233bd4ca3256da3ad5b4daaf0ebc55a2c26dd31efb9ec2'],
   [String.raw`{"s":"tab\there"}`, 'ee26bb6ed8a12b0ea3366592927fc72c3837aff0a20c1cd1c891e08066284d65'],
   [String.raw`{"nested":{"z":1,"a":2}}`, '872396769f22e9510fb3950e7dab20d79c5301ab12593ffdc76ca26a3656e1a6'],
   [String.raw`{"arr":[3,1,2]}`, 'cab5b2405701293d6fae18f8809e9946d87a2720a4cff2b9fcac9dde50528852'],
   [String.raw`{"null":null,"t":true}`, 'f965ee06f05d41a3f58b78f4b5cd891c39a4ea579a35aa010e01b5d10324179a'],
   [String.raw`{"empty":{}}`, 'c5cd747263892d516ee30100e488ff01ddc2f25ffe027ec5f8030d2a7c713a58'],
   [String.raw`{"u":"é"}`, '606ffff9f63ae3058a32788b12169fffef7f4f86e8e34e22cf3056949620ab37'],
];

test('a body fingerprints to the same bytes Go produces', () => {
   for (const [body, expected] of GO_FINGERPRINTS) {
      assert.equal(fingerprintJSON(body).toString('hex'), expected, body);
   }
});

test('key order and whitespace do not change the fingerprint', () => {
   // The whole point: the same request written two ways is one request.
   const a = fingerprintJSON('{"a":1,"b":2}').toString('hex');
   assert.equal(fingerprintJSON('{"b":2,"a":1}').toString('hex'), a);
   assert.equal(fingerprintJSON('{ "a" : 1 , "b" : 2 }').toString('hex'), a);
});

test('a number keeps the literal text it arrived as', () => {
   // Go decodes with UseNumber, so 1.0 is not 1. JSON.stringify would collapse
   // them and quietly call two different bodies the same.
   assert.equal(canonicalJSON(parseWithRawNumbers('{"n":1.0}')), '{"n":1.0}');
   assert.equal(canonicalJSON(parseWithRawNumbers('{"n":1e2}')), '{"n":1e2}');
   assert.notEqual(
      fingerprintJSON('{"n":1.0}').toString('hex'),
      fingerprintJSON('{"n":1}').toString('hex')
   );
});

test('a large integer is not rounded through a double', () => {
   assert.equal(
      canonicalJSON(parseWithRawNumbers('{"big":12345678901234567890}')),
      '{"big":12345678901234567890}'
   );
});

test('the HTML-significant characters are escaped, as Go escapes them', () => {
   assert.equal(canonicalJSON({ s: 'a<b>c&d' }), String.raw`{"s":"a\u003cb\u003ec\u0026d"}`);
});

test('nested objects sort at every level', () => {
   assert.equal(canonicalJSON(parseWithRawNumbers('{"z":{"y":1,"a":2},"a":3}')),
      '{"a":3,"z":{"a":2,"y":1}}');
});

test('array order is preserved, because an array is ordered', () => {
   assert.equal(canonicalJSON(parseWithRawNumbers('{"arr":[3,1,2]}')), '{"arr":[3,1,2]}');
});

test('an idempotency key is 16 to 128 visible ASCII characters', () => {
   assert.ok(validateIdempotencyKey('a'.repeat(16)));
   assert.ok(validateIdempotencyKey('a'.repeat(128)));
   assert.ok(!validateIdempotencyKey('a'.repeat(15)));
   assert.ok(!validateIdempotencyKey('a'.repeat(129)));
   assert.ok(!validateIdempotencyKey('has space'.padEnd(20, 'x')));
   assert.ok(!validateIdempotencyKey('tab\there'.padEnd(20, 'x')));
   assert.ok(!validateIdempotencyKey(''));
   // Bytes, not characters: Go bounds by len() on the string.
   assert.ok(!validateIdempotencyKey('é'.repeat(70)));
});

test('only safe headers are replayed', () => {
   // A replay is a new exchange: it must not resurrect the original request id
   // or anything set for that specific response.
   const replayed = replayHeaders({
      'content-type': ['application/json'],
      location: ['/api/v1/boards/1'],
      'set-cookie': ['session=secret'],
      'x-request-id': ['req_original'],
      etag: ['"abc"'],
   });
   assert.deepEqual(Object.keys(replayed).sort(), ['Content-Type', 'Etag', 'Location']);
   assert.equal(replayed['Set-Cookie'], undefined);
   assert.equal(replayed['X-Request-Id'], undefined);
});
