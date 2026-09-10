import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { coAuthorTrailer, withTrailers } from './commit-trailer.ts';

const on = { enabled: true, coAuthorTrailer: true };
const eve = { name: 'Eve Example', email: 'eve@example.com' };

describe('the Co-authored-by trailer on an agent commit', () => {
   test('credits the requester when GitHub and the toggle are both on', () => {
      assert.equal(coAuthorTrailer(on, eve), 'Co-authored-by: Eve Example <eve@example.com>');
   });

   test('is absent when the master switch is off, whatever the toggle says', () => {
      assert.equal(coAuthorTrailer({ enabled: false, coAuthorTrailer: true }, eve), null);
   });

   test('is absent when the toggle is off', () => {
      assert.equal(coAuthorTrailer({ enabled: true, coAuthorTrailer: false }, eve), null);
   });

   test('is absent with no settings or no author to credit', () => {
      assert.equal(coAuthorTrailer(null, eve), null);
      assert.equal(coAuthorTrailer(on, null), null);
   });

   test('is absent when the email is not an address', () => {
      assert.equal(coAuthorTrailer(on, { name: 'Eve', email: 'not-an-address' }), null);
      assert.equal(coAuthorTrailer(on, { name: 'Eve', email: null }), null);
   });

   test('a name cannot smuggle a second line or its own address into the trailer', () => {
      assert.equal(
         coAuthorTrailer(on, { name: 'Eve\n<evil@x.test>\nSigned-off-by: x', email: 'eve@example.com' }),
         'Co-authored-by: Eve evil@x.test Signed-off-by: x <eve@example.com>'
      );
   });

   test('never credits one of Berry’s own .invalid system identities', () => {
      assert.equal(coAuthorTrailer(on, { name: 'Orchestrator', email: 'intake@berry.invalid' }), null);
   });

   test('falls back to the address when there is no name', () => {
      assert.equal(
         coAuthorTrailer(on, { name: '  ', email: 'eve@example.com' }),
         'Co-authored-by: eve <eve@example.com>'
      );
   });
});

describe('appending trailers to a commit message', () => {
   const trailer = 'Co-authored-by: Eve <eve@example.com>';

   test('goes after one blank line', () => {
      assert.equal(withTrailers('subject', [trailer]), `subject\n\n${trailer}`);
      assert.equal(withTrailers('subject\n\nbody', [trailer]), `subject\n\nbody\n\n${trailer}`);
   });

   test('leaves the message alone with nothing to add', () => {
      assert.equal(withTrailers('subject', []), 'subject');
   });

   test('does not repeat a trailer the message already carries', () => {
      assert.equal(withTrailers(`subject\n\n${trailer}`, [trailer]), `subject\n\n${trailer}`);
   });
});
