import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.ts';

/**
 * The credential fallbacks, against the environment Compose actually passes.
 *
 * Compose hands an unset variable down as an empty string, so a fallback
 * written with `??` never falls: the empty AgentCore key counted as
 * configured, the clients got no credential, and the default chain found
 * MinIO's key — refused by AWS as an invalid security token.
 */

const base = {
   DATABASE_URL: 'postgres://berry:berry@localhost:5432/berry',
   BERRY_BEDROCK_REGION: 'us-east-1',
   BERRY_BEDROCK_ACCESS_KEY_ID: 'AKIABEDROCK',
   BERRY_BEDROCK_SECRET_ACCESS_KEY: 'bedrock-secret',
};

test('an empty AgentCore key falls through to the Bedrock one', () => {
   const config = loadConfig({
      ...base,
      BERRY_AGENTCORE_ACCESS_KEY_ID: '',
      BERRY_AGENTCORE_SECRET_ACCESS_KEY: '',
      BERRY_AGENTCORE_SESSION_TOKEN: '',
   });
   assert.equal(config.agentCore?.credentials?.accessKeyId, 'AKIABEDROCK');
   assert.equal(config.agentCore?.credentials?.secretAccessKey, 'bedrock-secret');
});

test('a named AgentCore key is preferred over the Bedrock one', () => {
   const config = loadConfig({ ...base, BERRY_AGENTCORE_ACCESS_KEY_ID: 'AKIACORE', BERRY_AGENTCORE_SECRET_ACCESS_KEY: 'core-secret' });
   assert.equal(config.agentCore?.credentials?.accessKeyId, 'AKIACORE');
});

test('no key at all means the default chain, as before', () => {
   const config = loadConfig({ DATABASE_URL: base.DATABASE_URL, BERRY_BEDROCK_REGION: 'us-east-1' });
   assert.equal(config.agentCore?.credentials, null);
});

const BASE_ENV = { DATABASE_URL: 'postgres://berry@localhost/berry' };

test('sign-in auth is off without a secret outside development', () => {
   const config = loadConfig({ ...BASE_ENV, APP_ENV: 'production' });
   assert.equal(config.auth.secret, null);
   assert.equal(config.auth.github, null);
   assert.equal(config.auth.devLogin, false);
});

test('development gets a stable fallback secret so a fresh checkout can sign in', () => {
   const first = loadConfig({ ...BASE_ENV, APP_ENV: 'development' });
   const second = loadConfig({ ...BASE_ENV, APP_ENV: 'development' });
   assert.ok(first.auth.secret && first.auth.secret.length >= 32);
   assert.equal(first.auth.secret, second.auth.secret);
});

test('an unset APP_ENV gets neither the fallback secret nor dev login', () => {
   const config = loadConfig({ ...BASE_ENV, AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true' });
   assert.equal(config.auth.secret, null);
   assert.equal(config.auth.devLogin, false);
});

test('a short auth secret is refused at boot', () => {
   assert.throws(
      () => loadConfig({ ...BASE_ENV, BERRY_AUTH_SECRET: 'too-short' }),
      (error: unknown) =>
         error instanceof ConfigError && /BERRY_AUTH_SECRET/.test(error.message)
   );
});

test('half a GitHub sign-in credential is refused at boot', () => {
   assert.throws(
      () =>
         loadConfig({
            ...BASE_ENV,
            BERRY_AUTH_SECRET: 'x'.repeat(32),
            BERRY_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc',
         }),
      (error: unknown) =>
         error instanceof ConfigError && /BERRY_AUTH_GITHUB_CLIENT_SECRET/.test(error.message)
   );
});

test('GitHub sign-in in production needs an explicit secret', () => {
   assert.throws(
      () =>
         loadConfig({
            ...BASE_ENV,
            APP_ENV: 'production',
            BERRY_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc',
            BERRY_AUTH_GITHUB_CLIENT_SECRET: 'shh',
         }),
      (error: unknown) => error instanceof ConfigError && /BERRY_AUTH_SECRET/.test(error.message)
   );
});

test('sign-in credentials are separate from the integrations GitHub credential', () => {
   const config = loadConfig({
      ...BASE_ENV,
      BERRY_AUTH_SECRET: 'x'.repeat(32),
      BERRY_AUTH_GITHUB_CLIENT_ID: 'signin-id',
      BERRY_AUTH_GITHUB_CLIENT_SECRET: 'signin-secret',
      GITHUB_CLIENT_ID: 'integration-id',
      GITHUB_CLIENT_SECRET: 'integration-secret',
   });
   assert.deepEqual(config.auth.github, { clientId: 'signin-id', clientSecret: 'signin-secret' });
   assert.deepEqual(config.integrations.github, {
      clientId: 'integration-id',
      clientSecret: 'integration-secret',
   });
});

test('the auth base URL is the app origin, and both origins are trusted', () => {
   const config = loadConfig({
      ...BASE_ENV,
      BERRY_AUTH_SECRET: 'x'.repeat(32),
      BERRY_APP_URL: 'https://app.berry.test/',
      BERRY_PUBLIC_URL: 'https://api.berry.test',
   });
   assert.equal(config.auth.baseUrl, 'https://app.berry.test');
   assert.deepEqual(config.auth.trustedOrigins, [
      'https://app.berry.test',
      'https://api.berry.test',
   ]);
});

test('dev login needs both the flag and a development environment', () => {
   assert.equal(
      loadConfig({ ...BASE_ENV, APP_ENV: 'development', AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true' })
         .auth.devLogin,
      true
   );
   assert.equal(
      loadConfig({
         ...BASE_ENV,
         APP_ENV: 'production',
         BERRY_AUTH_SECRET: 'x'.repeat(32),
         AUTH_ALLOW_PASSWORDLESS_LOGIN: 'true',
      }).auth.devLogin,
      false
   );
});
