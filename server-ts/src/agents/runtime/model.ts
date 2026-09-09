import { BedrockModel, type BaseModelConfig, type Model } from '@strands-agents/sdk';

/**
 * The one place a model is built.
 *
 * Every caller — a run, the planner, the triage pass, a chat reply, the editor
 * — used to construct its own client, and each one was a place for the
 * credentials to go missing (they did, five times over: BERR-67). One factory
 * means one set of plumbing to get right, and one seam for a test to replace
 * the model with a scripted one.
 */

export interface AwsCredentials {
   accessKeyId: string;
   secretAccessKey: string;
   // Not optional-with-undefined: the AWS clients are built with
   // `exactOptionalPropertyTypes`, and an explicit `undefined` is a different
   // thing to them than an absent key.
   sessionToken?: string;
}

export interface ModelSpec {
   /** A Bedrock inference profile id, e.g. `us.anthropic.claude-haiku-4-5-…`. */
   model: string;
   region: string;
   /**
    * Omitted means the AWS default chain — a role, or a local profile. That is
    * wrong wherever `AWS_ACCESS_KEY_ID` belongs to something else: in the
    * Compose stack it is MinIO's, and Bedrock rejects it as an invalid token.
    */
   credentials?: AwsCredentials | null | undefined;
   maxTokens?: number | undefined;
   temperature?: number | undefined;
   /**
    * Whether the reply streams. Streaming is what makes a run readable while
    * it runs, and it needs `bedrock:InvokeModelWithResponseStream`. A single
    * completion has nothing to show while it waits, and asking for the
    * streaming API would only widen the permission it needs.
    */
   stream?: boolean | undefined;
}

/** What builds a model. Production passes `bedrockModel`; tests pass a script. */
export type ModelFactory = (spec: ModelSpec) => Model<BaseModelConfig>;

/**
 * The ceiling on one model reply.
 *
 * Raised from 8192 after a run failed writing a README: a single `write_file`
 * call carries a whole file as tool input, and the SDK treats a reply cut off
 * at the ceiling as unrecoverable. The default model accepts this value; a
 * deployment on a model that does not sets `BERRY_AGENT_MAX_TOKENS`.
 */
export const DEFAULT_MAX_TOKENS = 32_000;

/**
 * What a family will accept as a reply ceiling. Bedrock refuses a request
 * above it outright, so a value the deployment or the default asks for is
 * clamped here rather than failing every run on that model: Nova Pro stops
 * at 10,000, the smaller Nova models at 5,000. Anything not listed keeps
 * what it was asked for.
 */
export function maxTokensFor(model: string, requested: number): number {
   if (/amazon\.nova-(pro|premier)/.test(model)) return Math.min(requested, 10_000);
   if (/amazon\.nova-/.test(model)) return Math.min(requested, 5_000);
   return requested;
}

/**
 * A Bedrock model for a spec.
 *
 * No API key: Bedrock authenticates with SigV4 through the AWS credential
 * chain, so a deployment on ECS or Lambda holds no model credential at all.
 */
export function bedrockModel(spec: ModelSpec): BedrockModel {
   return new BedrockModel({
      region: spec.region,
      ...(spec.credentials ? { clientConfig: { credentials: spec.credentials } } : {}),
      modelId: spec.model,
      maxTokens: maxTokensFor(spec.model, spec.maxTokens ?? DEFAULT_MAX_TOKENS),
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      ...(spec.stream === undefined ? {} : { stream: spec.stream }),
   });
}
