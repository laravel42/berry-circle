import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdkExecutor } from '../agents/executor.ts';
import { PlanGenerator } from '../plans/generator.ts';
import { PlanTriage } from '../plans/triage.ts';
import { ConversationResponder } from '../conversations/responder.ts';
import { EditorAssist } from '../editor/assist.ts';
import type { Sql } from '../db/pool.ts';
import type { Storage } from '../storage/storage.ts';
import type { AwsCredentials } from './bedrock-chat.ts';

/**
 * That every Bedrock caller accepts, and keeps, the credentials it is handed.
 *
 * This exists because of a bug the compiler could not see. `index.ts` passed
 * credentials to five constructors as `...(creds ? { credentials: creds } : {})`,
 * and five option types did not declare the field. TypeScript does not apply
 * excess-property checking to a spread, so the property was accepted at every
 * call site and dropped by every constructor. Each client then fell back to the
 * AWS default credential chain, which in the Compose stack resolves
 * `AWS_ACCESS_KEY_ID` to MinIO's `berryminio` — and Bedrock refuses it with
 * "The security token included in the request is invalid".
 *
 * The symptom was total: planning, repair, critique, classification, agent runs,
 * conversation replies and editor assists could not make one model call. The
 * model picker kept working, which made it look like a model problem, because
 * `ModelCatalog` was the one surface that did declare the field.
 *
 * What is checkable here, and what is not. Passing `credentials` below is itself
 * the assertion for four of these: each `credentials` argument is type-checked
 * against the option type, so if any of them stops declaring the field this file
 * fails to compile — which is exactly the failure that was missing. Whether the
 * constructor then forwards it cannot be observed from outside, because the
 * Bedrock client is held in a `#private` field and private names are not
 * reachable by reflection. The executor is the exception and is asserted
 * properly, so the honest summary is: the declaration is pinned for all five,
 * the retention for one.
 */

const CREDENTIALS: AwsCredentials = {
   accessKeyId: 'AKIAEXAMPLE',
   secretAccessKey: 'secret',
};

const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const sql = (() => {}) as unknown as Sql;
const storage = {} as unknown as Storage;

test('every Bedrock caller declares a credentials option', () => {
   // Constructed, not merely typed: a constructor that threw on the field would
   // pass a types-only check and fail in production.
   assert.doesNotThrow(() => {
      new PlanGenerator({ sql, region: 'us-east-1', credentials: CREDENTIALS, defaultModel: MODEL });
      new PlanTriage({ sql, region: 'us-east-1', credentials: CREDENTIALS, defaultModel: MODEL });
      new ConversationResponder({
         sql,
         region: 'us-east-1',
         credentials: CREDENTIALS,
         defaultModel: MODEL,
      });
      new EditorAssist({ region: 'us-east-1', credentials: CREDENTIALS, defaultModel: MODEL });
   });
});

test('the executor keeps the credentials it will hand to the agent runtime', () => {
   // The executor builds no client of its own: the model belongs to the agent,
   // so credentials go into `runAgent` per run. The property under test is that
   // it kept them at all — dropping them here is what made every run fail
   // before its first model call.
   const executor = new AdkExecutor({
      sql,
      storage,
      region: 'us-east-1',
      credentials: CREDENTIALS,
   });
   const held = Reflect.ownKeys(executor)
      .map((key) => Reflect.getOwnPropertyDescriptor(executor, key)?.value)
      .find(
         (value): value is AwsCredentials =>
            typeof value === 'object' &&
            value !== null &&
            (value as Partial<AwsCredentials>).accessKeyId === CREDENTIALS.accessKeyId
      );
   assert.deepEqual(held, CREDENTIALS, 'the executor discarded its credentials');
});

test('omitting credentials is still allowed, and means the default chain', () => {
   // A deployment on an instance role passes none, and must not be forced to
   // invent a key pair to satisfy the option.
   assert.doesNotThrow(() => {
      new PlanGenerator({ sql, region: 'us-east-1', defaultModel: MODEL });
      new AdkExecutor({ sql, storage, region: 'us-east-1' });
   });
});
