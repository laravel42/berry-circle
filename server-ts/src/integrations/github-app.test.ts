import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import { GitHubAppUnavailable, appJwt, buildManifest, convertManifest } from './github-app.ts';

/** The pure halves of the App flow: the JWT Berry signs and the answer it reads. */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decode(segment: string): Record<string, unknown> {
   return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('the App JWT', () => {
   const now = new Date('2026-09-02T00:00:00.000Z');

   test('is signed by the App key and verifies against its public half', () => {
      const [header, payload, signature] = appJwt(1234, pem, now).split('.');
      const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);

      assert.equal(verifier.verify(publicKey, signature!, 'base64url'), true);
   });

   test('is backdated, short-lived, and issued by the App', () => {
      const [header, payload] = appJwt(1234, pem, now).split('.');
      const claims = decode(payload!);
      const issued = Math.floor(now.getTime() / 1000);

      assert.deepEqual(decode(header!), { alg: 'RS256', typ: 'JWT' });
      assert.equal(claims.iss, '1234');
      // A minute behind, so a container clock running fast is not rejected.
      assert.equal(claims.iat, issued - 60);
      // Inside GitHub's ten-minute ceiling, measured from the backdated iat.
      assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
   });
});

describe('the manifest', () => {
   const manifest = buildManifest({
      name: 'Berry',
      appOrigin: 'http://localhost:3000',
      apiOrigin: 'http://localhost:3000',
   });

   test('registers every URL GitHub will redirect to', () => {
      assert.equal(
         manifest.redirect_url,
         'http://localhost:3000/api/v1/integrations/github/app/callback'
      );
      assert.deepEqual(manifest.callback_urls, [
         'http://localhost:3000/api/v1/integrations/callback/github',
      ]);
   });

   test('registers both origins when the API and the app differ', () => {
      const split = buildManifest({
         name: 'Berry',
         appOrigin: 'http://localhost:3000',
         apiOrigin: 'http://localhost:4000',
      });

      assert.deepEqual(split.callback_urls, [
         'http://localhost:4000/api/v1/integrations/callback/github',
         'http://localhost:3000/api/v1/integrations/callback/github',
      ]);
      assert.equal(
         manifest.setup_url,
         'http://localhost:3000/api/v1/integrations/github/installation/callback'
      );
   });

   test('asks for what an agent needs and nothing administrative', () => {
      assert.deepEqual(manifest.default_permissions, {
         contents: 'write',
         pull_requests: 'write',
         issues: 'write',
         metadata: 'read',
      });
      assert.equal(manifest.public, false);
   });
});

describe('converting the manifest code', () => {
   const answer = {
      id: 42,
      slug: 'berry-local',
      name: 'Berry',
      client_id: 'Iv23liExample',
      client_secret: 'secret-value',
      pem,
      webhook_secret: 'hook-value',
      html_url: 'https://github.com/apps/berry-local',
   };

   test('reads the one answer GitHub gives', async () => {
      const converted = await convertManifest('code-1', {
         apiBaseUrl: 'https://api.example.test',
         fetch: async (input) => {
            assert.equal(
               String(input),
               'https://api.example.test/app-manifests/code-1/conversions'
            );
            return new Response(JSON.stringify(answer), { status: 201 });
         },
      });

      assert.equal(converted.appId, 42);
      assert.equal(converted.clientId, 'Iv23liExample');
      assert.equal(converted.privateKey, pem);
      assert.equal(converted.webhookSecret, 'hook-value');
   });

   test('a refused conversion is not a half-made App', async () => {
      await assert.rejects(
         convertManifest('spent', {
            fetch: async () => new Response('code expired', { status: 422 }),
         }),
         (error: unknown) =>
            error instanceof GitHubAppUnavailable && /422/.test((error as Error).message)
      );
   });

   test('an answer missing the private key is refused rather than stored', async () => {
      await assert.rejects(
         convertManifest('partial', {
            fetch: async () =>
               new Response(JSON.stringify({ ...answer, pem: undefined }), { status: 201 }),
         }),
         GitHubAppUnavailable
      );
   });
});
