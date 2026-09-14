import type { Logger } from '../../../observability/log.ts';
import { bedrockModel, type AwsCredentials } from '../model.ts';
import { setupTelemetry } from '../telemetry.ts';
import { containerRepository } from './repository.ts';
import { createRuntimeServer } from './server.ts';
import { SessionRegistry } from './sessions.ts';

/**
 * The runtime image's entrypoint.
 *
 * In AgentCore the credential is the runtime's execution role, so the
 * `BERRY_BEDROCK_*` pair is unset and Bedrock uses the default chain. Locally
 * (the `agent-runtime` Compose service) the pair is how the same image reaches
 * Bedrock; `AWS_ACCESS_KEY_ID` is never read, because in the stack it is MinIO's.
 */
const env = process.env;
const region = (env.BERRY_BEDROCK_REGION ?? env.AWS_REGION ?? 'us-east-1').trim();
const accessKeyId = (env.BERRY_BEDROCK_ACCESS_KEY_ID ?? '').trim();
const secretAccessKey = (env.BERRY_BEDROCK_SECRET_ACCESS_KEY ?? '').trim();
const sessionToken = (env.BERRY_BEDROCK_SESSION_TOKEN ?? '').trim();
const credentials: AwsCredentials | null =
   accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } : null;

const server = createRuntimeServer({
   registry: new SessionRegistry(),
   modelFactory: (spec) => bedrockModel({ ...spec, credentials: spec.credentials ?? credentials }),
   region,
   credentials,
   workRoot: env.BERRY_RUNTIME_WORK_ROOT ?? '/mnt/workspace',
   repository: containerRepository(),
   localControl: (env.BERRY_RUNTIME_LOCAL_CONTROL ?? '').trim().toLowerCase() === 'true',
   videoOutput: /^s3:\/\//.test((env.BERRY_MEDIA_VIDEO_S3_URI ?? '').trim())
      ? { s3Uri: (env.BERRY_MEDIA_VIDEO_S3_URI ?? '').trim() }
      : undefined,
});

// Traces of model and tool calls start here now: the server makes none.
// A console-backed logger, because the server's logger module is not shipped.
const logger = { info: console.log, error: console.error, warn: console.warn, debug: () => {} } as unknown as Logger;
await setupTelemetry(logger);

// 0.0.0.0, not localhost: AgentCore's health checks come from outside the container.
server.listen(Number(env.PORT ?? 8080), '0.0.0.0', () => {
   console.log(JSON.stringify({ msg: 'berry agent runtime listening', port: Number(env.PORT ?? 8080) }));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
   process.once(signal, () => server.close(() => process.exit(0)));
}
