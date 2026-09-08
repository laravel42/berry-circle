import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import type { AwsCredentials } from './bedrock-chat.ts';
/**
 * The models an agent can be switched to.
 *
 * Minus the half that used to make this complicated. The runtime reported a
 * catalogue with a provider's entries compiled in, so they went stale and a
 * working pairing read as unavailable. The list is read live instead.
 *
 * Bedrock is asked for inference profiles rather than foundation models: a
 * profile is what an account can actually invoke, and offering a bare model id
 * would list models that fail at the first call.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** One selectable model as the product sees it. */
export interface CatalogModel {
   id: string;
   displayName: string;
   provider: string;
   tier: string;
   contextWindow: number;
   inputCostPerM: number;
   outputCostPerM: number;
   supportsTools: boolean;
   supportsVision: boolean;
}

export interface CatalogOptions {
   /** The AWS region Bedrock is called in. */
   region: string;
   /** Injected by tests; production builds one from the region. */
   bedrock?: BedrockClient;
   /** Omitted means the AWS default chain. */
   credentials?: AwsCredentials | null;
   /**
    * Bounds how stale the list may be. It changes on the provider's release
    * schedule rather than Berry's, so a short cache costs nothing and spares
    * every picker render a 400-model fetch.
    */
   ttlMs?: number;
   clock?: () => number;
}

/** The provider every model here is served by. */
export const PROVIDER = 'bedrock';

export class ModelCatalog {
   private readonly ttlMs: number;
   private readonly bedrock: BedrockClient;
   private readonly clock: () => number;
   private cached: CatalogModel[] | null = null;
   private cachedAt = 0;
   private inFlight: Promise<CatalogModel[]> | null = null;

   constructor(options: CatalogOptions) {
      this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
      this.bedrock =
         options.bedrock ??
         new BedrockClient({
            region: options.region,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
      this.clock = options.clock ?? Date.now;
   }

   /**
    * The catalogue, refreshed when stale.
    *
    * A failed refresh serves the previous list rather than nothing: a
    * transient fetch failure should not empty a picker that worked a minute
    * ago. With no previous list it throws, because an empty catalogue and an
    * unreachable one mean different things to the caller — one says "no models
    * exist", which would be a lie.
    */
   async list(): Promise<CatalogModel[]> {
      if (this.cached && this.clock() - this.cachedAt < this.ttlMs) return this.cached;
      // One fetch even when several requests arrive at once on a cold cache:
      // a picker opened by ten people should cost one round trip, not ten.
      this.inFlight ??= this.refresh().finally(() => {
         this.inFlight = null;
      });
      try {
         return await this.inFlight;
      } catch (error) {
         if (this.cached) return this.cached;
         throw error;
      }
   }

   private async refresh(): Promise<CatalogModel[]> {
      const response = await this.bedrock
         .send(
            new ListInferenceProfilesCommand({
               // Only the profiles this account can actually invoke. Listing
               // foundation models instead would offer models that fail at the
               // first call, because Anthropic models on Bedrock are reachable
               // through a cross-region profile rather than by bare id.
               maxResults: 100,
               typeEquals: 'SYSTEM_DEFINED',
            })
         )
         .catch((cause: unknown) => {
            throw new CatalogUnavailable(
               `Bedrock could not list inference profiles: ${cause instanceof Error ? cause.message : String(cause)}`
            );
         });

      const models = (response.inferenceProfileSummaries ?? [])
         .filter((entry) => entry.inferenceProfileId)
         .map(toCatalogModel);
      if (models.length === 0) throw new CatalogUnavailable('Bedrock listed no inference profiles');

      this.cached = models;
      this.cachedAt = this.clock();
      return models;
   }
}

export class CatalogUnavailable extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'CatalogUnavailable';
   }
}

/**
 * One Bedrock inference profile as a row in the picker.
 *
 * Bedrock publishes neither pricing nor context window on this API, so those
 * are zero rather than invented. Empty is a fact the UI can render as unknown;
 * a plausible guess would be shown in a column people read as true — which is
 * why the previous catalogue left `tier` empty for the same reason.
 */
function toCatalogModel(entry: {
   inferenceProfileId?: string | undefined;
   inferenceProfileName?: string | undefined;
}): CatalogModel {
   const id = entry.inferenceProfileId!;
   return {
      id,
      displayName: entry.inferenceProfileName || id,
      provider: PROVIDER,
      tier: '',
      contextWindow: 0,
      inputCostPerM: 0,
      outputCostPerM: 0,
      // Every model Berry runs an agent on has to take tools, and Converse
      // supports them across the families Bedrock exposes this way.
      supportsTools: true,
      supportsVision: false,
   };
}

function perMillion(price: string | undefined): number {
   const value = Number.parseFloat(price ?? '');
   return Number.isFinite(value) ? value * 1_000_000 : 0;
}

/**
 * Confirms a provider/model pair is one this deployment can actually serve.
 *
 * Refused at selection rather than discovered on the agent's next task, which
 * is the only other place a bad pair would surface — as a failed run, minutes
 * later, with nothing pointing back at the picker.
 */
export function resolveModel(
   models: CatalogModel[],
   provider: string,
   model: string
): CatalogModel | undefined {
   const wanted = normalizeModelId(provider, model);
   return models.find(
      (candidate) =>
         candidate.provider === provider &&
         normalizeModelId(candidate.provider, candidate.id) === wanted
   );
}

/**
 * Strips a provider prefix repeated inside a model id.
 *
 * Kept because the stored pairings still carry it: agents configured against
 * the previous catalogue hold ("openrouter",
 * "openrouter/anthropic/claude-sonnet-4"), and dropping the normalisation
 * would make every one of them read as unavailable.
 */
export function normalizeModelId(provider: string, id: string): string {
   if (!provider || !id) return id;
   return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}
