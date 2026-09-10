import { tool, type Tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { PollyClient, SynthesizeSpeechCommand, type PollyClientConfig } from '@aws-sdk/client-polly';
import {
   BedrockRuntimeClient,
   GetAsyncInvokeCommand,
   StartAsyncInvokeCommand,
   type BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, ListObjectsV2Command, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AwsCredentials } from '../model.ts';

/**
 * Media an agent can make, as tools.
 *
 * A text-to-speech or text-to-video agent is a chat model that writes the
 * script and a tool that renders it. The rendering models are not chat
 * models: Amazon Polly answers a synthesis request with audio, and Amazon
 * Nova Reel is an asynchronous job that writes a video to S3. Neither can
 * drive the agent loop, so neither is an agent's `model_name`; they are what
 * the agent calls. The result lands as an artifact on the task, at the path
 * the agent chose, which is how the person who asked gets the file.
 *
 * Every client is built lazily and can be injected, so a test hands in fakes
 * and production builds from the same credential the runs use.
 */

export interface VideoOutput {
   /** `s3://bucket/prefix` the video job writes into. A real S3 bucket, not MinIO. */
   s3Uri: string;
}

export interface MediaScope {
   region: string;
   credentials?: AwsCredentials | null | undefined;
   runId: string;
   /** Saves the rendered bytes as an artifact on the task. */
   save(input: { path: string; bytes: Uint8Array; contentType: string }): Promise<void>;
   /** Absent means no video tool: nowhere for the job to write. */
   video?: VideoOutput | undefined;
   clients?: {
      polly?: Pick<PollyClient, 'send'>;
      bedrock?: Pick<BedrockRuntimeClient, 'send'>;
      s3?: Pick<S3Client, 'send'>;
   };
   /** Test seams for the video job's wait. */
   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
   pollIntervalMs?: number;
   maxWaitMs?: number;
}

/** Polly's ceiling for one synchronous request, in characters of plain text. */
const MAX_SPEECH_CHARS = 3000;
const DEFAULT_VOICE = 'Joanna';
const VIDEO_MODEL = 'amazon.nova-reel-v1:1';
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

export function mediaTools(scope: MediaScope): Tool[] {
   const tools = [generateSpeech(scope)];
   if (scope.video) tools.push(generateVideo(scope, scope.video));
   return tools;
}

function clientConfig(scope: MediaScope): { region: string; credentials?: AwsCredentials } {
   return { region: scope.region, ...(scope.credentials ? { credentials: scope.credentials } : {}) };
}

function generateSpeech(scope: MediaScope): Tool {
   return tool({
      name: 'generate_speech',
      description:
         'Turn text into spoken audio (MP3) with Amazon Polly and save it as a file on this task. ' +
         `One call takes at most ${MAX_SPEECH_CHARS} characters; split longer scripts into several files.`,
      inputSchema: z.object({
         text: z.string().describe('The words to speak. Plain text, or SSML when ssml is true.'),
         path: z.string().describe('Where to save the audio, e.g. narration/intro.mp3'),
         voice: z
            .string()
            .optional()
            .describe(`A Polly neural voice id such as Joanna, Matthew, Amy or Brian. Defaults to ${DEFAULT_VOICE}.`),
         ssml: z.boolean().optional().describe('True when text is SSML markup.'),
         language: z.string().optional().describe('A BCP-47 code such as en-US, when the voice supports several.'),
      }),
      callback: async ({ text, path, voice, ssml, language }, context?: ToolContext) => {
         const trimmed = text.trim();
         if (trimmed === '') return { error: 'text was empty' };
         if (trimmed.length > MAX_SPEECH_CHARS) {
            return {
               error: `text is ${trimmed.length} characters; one call takes at most ${MAX_SPEECH_CHARS}. Split it into parts and call once per part.`,
            };
         }
         const polly = scope.clients?.polly ?? new PollyClient(clientConfig(scope) as PollyClientConfig);
         try {
            const output = await polly.send(
               new SynthesizeSpeechCommand({
                  Text: trimmed,
                  TextType: ssml ? 'ssml' : 'text',
                  VoiceId: (voice ?? DEFAULT_VOICE) as never,
                  Engine: 'neural',
                  OutputFormat: 'mp3',
                  ...(language ? { LanguageCode: language as never } : {}),
               }),
               abortOptions(context?.cancelSignal)
            );
            const bytes = output.AudioStream ? await output.AudioStream.transformToByteArray() : new Uint8Array();
            if (bytes.byteLength === 0) return { error: 'Polly returned no audio' };
            const saved = withExtension(path, '.mp3');
            await scope.save({ path: saved, bytes, contentType: 'audio/mpeg' });
            return { path: saved, bytes: bytes.byteLength, voice: voice ?? DEFAULT_VOICE, saved: true };
         } catch (error) {
            return { error: describe(error, 'speech could not be generated') };
         }
      },
   });
}

function generateVideo(scope: MediaScope, video: VideoOutput): Tool {
   return tool({
      name: 'generate_video',
      description:
         'Generate a short video clip from a text prompt with Amazon Nova Reel and save it as an MP4 on this task. ' +
         'A clip is 6 seconds at 1280x720; the call waits for the render, which takes a few minutes.',
      inputSchema: z.object({
         prompt: z
            .string()
            .describe('What the clip shows: subject, setting, camera motion, lighting, style. Under 512 characters.'),
         path: z.string().describe('Where to save the clip, e.g. clips/opening.mp4'),
         seed: z.number().int().min(0).max(2_147_483_646).optional().describe('Fix to reproduce a clip.'),
      }),
      callback: async ({ prompt, path, seed }, context?: ToolContext) => {
         const text = prompt.trim();
         if (text === '') return { error: 'prompt was empty' };
         if (text.length > 512) return { error: `prompt is ${text.length} characters; Nova Reel takes at most 512.` };
         const bedrock =
            scope.clients?.bedrock ?? new BedrockRuntimeClient(clientConfig(scope) as BedrockRuntimeClientConfig);
         const s3 = scope.clients?.s3 ?? new S3Client(clientConfig(scope) as S3ClientConfig);
         const sleep = scope.sleep ?? defaultSleep;
         const signal = context?.cancelSignal;
         // One folder per call, so two clips on one run never overwrite each
         // other. The trailing slash is what makes it a directory to Bedrock;
         // without it the job is refused as pointing at neither a bucket nor
         // a directory.
         const folder = `${video.s3Uri.replace(/\/$/, '')}/${scope.runId}/${Date.now()}/`;

         try {
            const started = await bedrock.send(
               new StartAsyncInvokeCommand({
                  modelId: VIDEO_MODEL,
                  modelInput: {
                     taskType: 'TEXT_VIDEO',
                     textToVideoParams: { text },
                     videoGenerationConfig: {
                        durationSeconds: 6,
                        fps: 24,
                        dimension: '1280x720',
                        seed: seed ?? Math.floor(Math.random() * 2_147_483_646),
                     },
                  },
                  outputDataConfig: { s3OutputDataConfig: { s3Uri: folder } },
               }),
               abortOptions(signal)
            );
            const invocationArn = started.invocationArn;
            if (!invocationArn) return { error: 'Nova Reel did not start the job' };

            const deadline = Date.now() + (scope.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
            for (;;) {
               const job = await bedrock.send(new GetAsyncInvokeCommand({ invocationArn }), abortOptions(signal));
               if (job.status === 'Completed') break;
               if (job.status === 'Failed') return { error: `the video job failed: ${job.failureMessage ?? 'no reason given'}` };
               if (Date.now() > deadline) return { error: 'the video job did not finish in time; it may still complete in S3' };
               await sleep(scope.pollIntervalMs ?? DEFAULT_POLL_MS, signal);
            }

            const bytes = await downloadVideo(s3, folder, signal);
            if (!bytes) return { error: 'the video job completed but no MP4 was found in the output location' };
            const saved = withExtension(path, '.mp4');
            await scope.save({ path: saved, bytes, contentType: 'video/mp4' });
            return { path: saved, bytes: bytes.byteLength, durationSeconds: 6, saved: true };
         } catch (error) {
            return { error: describe(error, 'the video could not be generated') };
         }
      },
   });
}

/** The MP4 Nova Reel wrote under the job's folder, wherever it put it. */
async function downloadVideo(
   s3: Pick<S3Client, 'send'>,
   folder: string,
   signal: AbortSignal | undefined
): Promise<Uint8Array | null> {
   const { bucket, prefix } = parseS3Uri(folder);
   const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }), abortOptions(signal));
   const key = (listed.Contents ?? []).map((object) => object.Key ?? '').find((candidate) => candidate.endsWith('.mp4'));
   if (!key) return null;
   const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), abortOptions(signal));
   return object.Body ? object.Body.transformToByteArray() : null;
}

export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
   const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
   if (!match) throw new Error(`not an S3 URI: ${uri}`);
   return { bucket: match[1]!, prefix: match[2] ?? '' };
}

/** The SDK's call options, with the key absent rather than undefined when there is no signal. */
function abortOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
   return signal ? { abortSignal: signal } : {};
}

function withExtension(path: string, extension: string): string {
   const clean = path.trim().replace(/^\/+/, '');
   return clean.toLowerCase().endsWith(extension) ? clean : `${clean}${extension}`;
}

function describe(error: unknown, fallback: string): string {
   const name = (error as { name?: string })?.name;
   const message = error instanceof Error ? error.message : String(error);
   if (name === 'AccessDeniedException' || name === 'AccessDenied') {
      return `${fallback}: the deployment's AWS credential is not allowed to (${message}). This needs a permission change, not a retry.`;
   }
   return `${fallback}: ${message}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
   return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
         'abort',
         () => {
            clearTimeout(timer);
            reject(new Error('the run was cancelled'));
         },
         { once: true }
      );
   });
}
