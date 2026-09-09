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
}

/** What builds a model. Production passes `bedrockModel`; tests pass a script. */
export type ModelFactory = (spec: ModelSpec) => Model<BaseModelConfig>;

export const DEFAULT_MAX_TOKENS = 8192;

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
      maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
   });
}
