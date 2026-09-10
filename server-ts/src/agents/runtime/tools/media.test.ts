import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaTools, parseS3Uri, type MediaScope } from './media.ts';

/**
 * The tools that render media. Polly, Bedrock and S3 are fakes; what is
 * pinned is what reaches them, what is saved, and what the model is told
 * when something is refused.
 */

function scope(overrides: Partial<MediaScope> = {}) {
   const saved: Array<{ path: string; bytes: number; contentType: string }> = [];
   const base: MediaScope = {
      region: 'us-east-1',
      runId: 'run-1',
      save: async ({ path, bytes, contentType }) => {
         saved.push({ path, bytes: bytes.byteLength, contentType });
      },
      sleep: async () => undefined,
      pollIntervalMs: 0,
      ...overrides,
   };
   return { scope: base, saved };
}

function invoke(tools: ReturnType<typeof mediaTools>, name: string, input: object): Promise<Record<string, unknown>> {
   const t = tools.find((candidate) => candidate.name === name);
   assert.ok(t, `${name} is offered`);
   return (t as unknown as { invoke: (a: object) => Promise<Record<string, unknown>> }).invoke(input);
}

test('speech is synthesised with a neural voice and saved as an MP3 artifact', async () => {
   const requests: unknown[] = [];
   const polly = {
      send: async (command: { input: unknown }) => {
         requests.push(command.input);
         return { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      },
   };
   const { scope: s, saved } = scope({ clients: { polly: polly as never } });
   const result = await invoke(mediaTools(s), 'generate_speech', { text: 'Hello there.', path: 'narration/intro' });

   assert.deepEqual(result, { path: 'narration/intro.mp3', bytes: 3, voice: 'Joanna', saved: true });
   assert.deepEqual(saved, [{ path: 'narration/intro.mp3', bytes: 3, contentType: 'audio/mpeg' }]);
   assert.deepEqual(requests[0], { Text: 'Hello there.', TextType: 'text', VoiceId: 'Joanna', Engine: 'neural', OutputFormat: 'mp3' });
});

test('a script over the per-call ceiling is refused with the instruction to split it', async () => {
   const { scope: s, saved } = scope({ clients: { polly: { send: async () => assert.fail('not called') } as never } });
   const result = await invoke(mediaTools(s), 'generate_speech', { text: 'x'.repeat(3001), path: 'a.mp3' });
   assert.match(String(result.error), /3001 characters.*split/i);
   assert.equal(saved.length, 0);
});

test('a permission the credential lacks is said plainly, not retried', async () => {
   const denied = Object.assign(new Error('User is not authorized to perform: polly:SynthesizeSpeech'), { name: 'AccessDeniedException' });
   const { scope: s } = scope({ clients: { polly: { send: async () => { throw denied; } } as never } });
   const result = await invoke(mediaTools(s), 'generate_speech', { text: 'hi', path: 'a' });
   assert.match(String(result.error), /permission change, not a retry/);
});

test('video is offered only with somewhere to write, and is not offered otherwise', () => {
   const { scope: s } = scope();
   assert.deepEqual(mediaTools(s).map((t) => t.name), ['generate_speech']);
   const { scope: withVideo } = scope({ video: { s3Uri: 's3://media-bucket/berry' } });
   assert.deepEqual(mediaTools(withVideo).map((t) => t.name), ['generate_speech', 'generate_video']);
});

test('a video job is started, waited on, fetched from S3 and saved as an MP4', async () => {
   const calls: string[] = [];
   let polls = 0;
   const bedrock = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
         calls.push(command.constructor.name);
         if (command.constructor.name === 'StartAsyncInvokeCommand') {
            const output = (command.input.outputDataConfig as { s3OutputDataConfig: { s3Uri: string } }).s3OutputDataConfig.s3Uri;
            // Bedrock only takes a directory, and a directory ends in a slash:
            // without one the job is refused as "not a bucket or a directory".
            assert.match(output, /^s3:\/\/media-bucket\/berry\/run-1\/\d+\/$/);
            assert.equal((command.input.modelInput as { taskType: string }).taskType, 'TEXT_VIDEO');
            return { invocationArn: 'arn:job' };
         }
         polls += 1;
         return { status: polls < 3 ? 'InProgress' : 'Completed' };
      },
   };
   const s3 = {
      send: async (command: { constructor: { name: string } }) => {
         calls.push(command.constructor.name);
         if (command.constructor.name === 'ListObjectsV2Command') {
            return { Contents: [{ Key: 'berry/run-1/1/manifest.json' }, { Key: 'berry/run-1/1/output.mp4' }] };
         }
         return { Body: { transformToByteArray: async () => new Uint8Array(10) } };
      },
   };
   const { scope: s, saved } = scope({ video: { s3Uri: 's3://media-bucket/berry' }, clients: { bedrock: bedrock as never, s3: s3 as never } });
   const result = await invoke(mediaTools(s), 'generate_video', { prompt: 'A slow pan over a foggy harbour at dawn', path: 'clips/01-opening' });

   assert.deepEqual(result, { path: 'clips/01-opening.mp4', bytes: 10, durationSeconds: 6, saved: true });
   assert.deepEqual(saved, [{ path: 'clips/01-opening.mp4', bytes: 10, contentType: 'video/mp4' }]);
   assert.equal(polls, 3, 'polled until the job completed');
   assert.ok(calls.includes('ListObjectsV2Command') && calls.includes('GetObjectCommand'));
});

test('a failed video job reports the reason', async () => {
   const bedrock = {
      send: async (command: { constructor: { name: string } }) =>
         command.constructor.name === 'StartAsyncInvokeCommand' ? { invocationArn: 'arn' } : { status: 'Failed', failureMessage: 'content filtered' },
   };
   const { scope: s } = scope({ video: { s3Uri: 's3://b/p' }, clients: { bedrock: bedrock as never, s3: { send: async () => ({}) } as never } });
   const result = await invoke(mediaTools(s), 'generate_video', { prompt: 'x', path: 'c' });
   assert.match(String(result.error), /content filtered/);
});

test('an S3 URI is split into bucket and prefix', () => {
   assert.deepEqual(parseS3Uri('s3://media-bucket/berry/out'), { bucket: 'media-bucket', prefix: 'berry/out' });
   assert.deepEqual(parseS3Uri('s3://media-bucket'), { bucket: 'media-bucket', prefix: '' });
   assert.throws(() => parseS3Uri('https://x'), /not an S3 URI/);
});
