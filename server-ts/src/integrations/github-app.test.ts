import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import {
   GitHubAppRepository,
   GitHubAppUnavailable,
   appJwt,
   buildManifest,
   convertManifest,
} from './github-app.ts';
import { AUTH_BASE_PATH } from '../auth/better-auth.ts';
import { sealerFromKey } from './sealing.ts';
import type { Sql } from '../db/pool.ts';

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
         'http://localhost:3000/api/auth/callback/github',
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
         'http://localhost:3000/api/auth/callback/github',
         'http://localhost:4000/api/auth/callback/github',
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
         // Read-only: the issue sidebar shows check results, and nothing
         // Berry does needs to create or rerun a check.
         checks: 'read',
         // Sign-in's half: GitHub hands over a verified address only with this,
         // and an account that keeps its email private has no other way in.
         emails: 'read',
      });
      assert.equal(manifest.public, false);
   });

   test('registers the sign-in callback beside the install one', () => {
      // Sign-in runs on this App, so Better Auth's callback has to be one of
      // the URLs the App is created with — GitHub matches a redirect_uri
      // exactly, and it cannot be added later without editing the App by hand.
      assert.ok(
         (manifest.callback_urls as string[]).includes(
            `http://localhost:3000${AUTH_BASE_PATH}/callback/github`
         )
      );
   });

   test('asks GitHub to authorize whoever installs it', () => {
      // Without this the install finishes with an App nobody has authorized,
      // and the operator who created it still has no account to sign in with.
      assert.equal(manifest.request_oauth_on_install, true);
   });

   test('delivers webhooks to the route that serves them, for the events Berry applies', () => {
      assert.deepEqual(manifest.hook_attributes, {
         url: 'http://localhost:3000/api/v1/webhooks/github',
         active: true,
      });
      assert.deepEqual(manifest.default_events, [
         'pull_request',
         'pull_request_review',
         'check_run',
         'check_suite',
         'push',
      ]);
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

describe('the App’s webhook secret', () => {
   const sealer = sealerFromKey(randomBytes(32).toString('base64'));

   function repository(row: Record<string, unknown> | null): GitHubAppRepository {
      const sql = async (strings: TemplateStringsArray) => {
         const text = strings.join('?');
         if (text.includes('webhook_secret_encrypted')) return row ? [row] : [];
         throw new Error(`unexpected query: ${text}`);
      };
      return new GitHubAppRepository({ sql: sql as unknown as Sql, sealer });
   }

   test('is opened from its sealed form, for a signature check', async () => {
      const sealed = sealer.seal('hook-value');
      assert.equal(await repository({ webhook_secret_encrypted: sealed }).webhookSecret(), 'hook-value');
   });

   test('is null for an App GitHub gave no secret, or when there is no App', async () => {
      assert.equal(await repository({ webhook_secret_encrypted: null }).webhookSecret(), null);
      assert.equal(await repository(null).webhookSecret(), null);
   });
});

describe('minting an installation token', () => {
   const sealer = sealerFromKey(randomBytes(32).toString('base64'));
   const sealedKey = sealer.seal(pem);

   /** A database holding one App and one installation. */
   function fakeSql(): Sql {
      const sql = async (strings: TemplateStringsArray) => {
         const text = strings.join('?');
         if (text.includes('FROM github_installations')) {
            return [{ workspace_id: 'ws', installation_id: '77', account_login: 'ann', account_type: 'User' }];
         }
         if (text.includes('FROM github_apps')) {
            return [{ app_id: '42', private_key_encrypted: sealedKey }];
         }
         throw new Error(`unexpected query: ${text}`);
      };
      return sql as unknown as Sql;
   }

   function app(permissions: Record<string, string>) {
      return new GitHubAppRepository({
         sql: fakeSql(),
         sealer,
         apiBaseUrl: 'https://api.example.test',
         fetch: async (input, init) => {
            assert.equal(String(input), 'https://api.example.test/app/installations/77/access_tokens');
            assert.equal(init?.method, 'POST');
            return new Response(
               JSON.stringify({
                  token: 'ghs_minted',
                  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                  permissions,
                  repository_selection: 'selected',
               }),
               { status: 201 }
            );
         },
      });
   }

   test('the token carries whether the installation may push, from the mint itself', async () => {
      // GitHub reports a repository's `permissions` for a user and answers an
      // App token with all-false, so the mint is the only place that says.
      const writer = await app({ contents: 'write', metadata: 'read' }).access('ws');
      assert.equal(writer.token, 'ghs_minted');
      assert.equal(writer.canPush, true);

      const reader = await app({ contents: 'read', metadata: 'read' }).access('ws');
      assert.equal(reader.canPush, false);
   });

   test('token() is the same mint, and the cache keeps the grant with it', async () => {
      const repository = app({ contents: 'write' });
      assert.equal(await repository.token('ws'), 'ghs_minted');
      assert.equal((await repository.access('ws')).canPush, true);
   });
});

describe("the App's sign-in credentials", () => {
   const sealer = sealerFromKey(randomBytes(32).toString('base64'));

   /** A database holding one App, or none. */
   function repository(row: Record<string, unknown> | null): GitHubAppRepository {
      const sql = async (strings: TemplateStringsArray) => {
         const text = strings.join('?');
         if (text.includes('FROM github_apps')) return row ? [row] : [];
         throw new Error(`unexpected query: ${text}`);
      };
      return new GitHubAppRepository({ sql: sql as unknown as Sql, sealer });
   }

   test('are opened from their sealed form for sign-in to use', async () => {
      const app = repository({
         client_id: 'Iv23liExample',
         client_secret_encrypted: sealer.seal('secret-value'),
      });

      assert.deepEqual(await app.clientCredentials(), {
         clientId: 'Iv23liExample',
         clientSecret: 'secret-value',
      });
   });

   test('carry a fingerprint that changes when they do, and opens nothing', async () => {
      const created = new Date('2026-09-10T00:00:00.000Z');
      const rotated = new Date('2026-09-11T00:00:00.000Z');
      const fingerprint = async (clientId: string, updatedAt: Date) =>
         repository({ client_id: clientId, updated_at: updatedAt }).signInFingerprint();

      const first = await fingerprint('Iv23liExample', created);
      assert.equal(typeof first, 'string');
      // The same App, untouched, is the same credential set: one instance.
      assert.equal(await fingerprint('Iv23liExample', created), first);
      // A rotated secret updates the row, and a new App has a new client id.
      assert.notEqual(await fingerprint('Iv23liExample', rotated), first);
      assert.notEqual(await fingerprint('Iv23liOther', created), first);
      // Nothing sealed is read to answer this, so nothing can leak through it.
      assert.equal(String(first).includes('secret'), false);
   });

   test('are absent, rather than an error, when there is no App', async () => {
      assert.equal(await repository(null).signInFingerprint(), null);
      assert.equal(await repository(null).clientCredentials(), null);
   });
});
