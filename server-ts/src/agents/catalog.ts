import {
   BedrockClient,
   ListFoundationModelsCommand,
   ListInferenceProfilesCommand,
   type FoundationModelSummary,
} from '@aws-sdk/client-bedrock';
import type { AwsCredentials } from './runtime/model.ts';
import {
   DEFAULT_PRICING_URL,
   fetchPortkeyPricing,
   priceForModel,
   stripRoutingPrefix,
   type ModelPrice,
} from './pricing.ts';

export { stripRoutingPrefix } from './pricing.ts';
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
    * Injected for tests; production uses the global. Prices come from Portkey's
    * open pricing dataset over HTTP, so the catalog needs a fetch — the same
    * injected-`fetch` pattern the SCM and integration clients use.
    */
   fetch?: typeof globalThis.fetch;
   /**
    * The Portkey Bedrock pricing feed. Overridable for tests; defaults to the
    * public, no-auth endpoint.
    */
   pricingUrl?: string;
   /**
    * Bounds how stale the list may be. It changes on the provider's release
    * schedule rather than Berry's, so a short cache costs nothing and spares
    * every picker render a 400-model fetch.
    */
   ttlMs?: number;
   clock?: () => number;
}

/**
 * Portkey's open (MIT) LLM pricing dataset for Bedrock. Free and unauthenticated
 * — a server-side, keyless data read, so it introduces no provider credential
 * and stays within Berry's "no secret leaves for a third party" boundary.
 * https://github.com/Portkey-AI/models
 */
/** The provider every model here is served by. */
export const PROVIDER = 'bedrock';

export class ModelCatalog {
   private readonly ttlMs: number;
   private readonly bedrock: BedrockClient;
   private readonly fetch: typeof globalThis.fetch;
   private readonly pricingUrl: string;
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
      this.fetch = options.fetch ?? globalThis.fetch;
      this.pricingUrl = options.pricingUrl ?? DEFAULT_PRICING_URL;
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
      // Two calls, because neither answers the whole question. The profile list
      // is what the account can actually invoke (Anthropic and friends are
      // reachable only through a cross-region profile, not a bare model id).
      // The foundation-model list is the only place Bedrock says what a model
      // can *do* — its modalities — which is how a text chat model is told from
      // an embedding or image model that would fail the agent's first Converse
      // call. The profiles are the source of truth for the list; the models
      // enrich and filter it.
      const [profiles, foundation, pricing] = await Promise.all([
         this.bedrock
            .send(
               new ListInferenceProfilesCommand({
                  maxResults: 100,
                  typeEquals: 'SYSTEM_DEFINED',
               })
            )
            .catch((cause: unknown) => {
               throw new CatalogUnavailable(
                  `Bedrock could not list inference profiles: ${
                     cause instanceof Error ? cause.message : String(cause)
                  }`
               );
            }),
         // Every model, not just text ones: the map has to be able to say a
         // model is non-text (so its profile is dropped) as distinct from
         // unknown (so its profile is kept). A failure here is not fatal —
         // without modality data the catalogue lists every profile rather than
         // none, and the run-time Converse call still refuses a bad model.
         this.bedrock
            .send(new ListFoundationModelsCommand({}))
            .then((response) => response.modelSummaries ?? [])
            .catch(() => [] as FoundationModelSummary[]),
         // Prices from Portkey's open dataset. Best-effort like the modality
         // call: a failure leaves the map empty and prices read as unknown
         // (zero), never emptying or blocking the catalogue.
         this.fetchPricing(),
      ]);

      const capability = indexByModel(foundation);
      // When the foundation list came back empty (the call failed, or the
      // account genuinely has none), there is nothing to filter against, so
      // every profile is kept — an unfiltered picker beats an empty one, and
      // Converse still refuses a truly incapable model at run time.
      const canFilter = capability.size > 0;
      const models = (profiles.inferenceProfileSummaries ?? [])
         .filter((entry) => entry.inferenceProfileId)
         // Drop the `global.` cross-region routing family. Bedrock lists both a
         // regional (`us.`) and a global (`global.`) profile for many models, so
         // keeping both shows the picker two near-identical rows per model. The
         // deployment invokes in one region, so the regional profile is the one
         // to offer; the global duplicate is noise. Any agent already pinned to
         // a `us.` id is unaffected, since resolveModel matches the exact id.
         .filter((entry) => !isGlobalProfile(entry.inferenceProfileId!))
         .map((entry) => toCatalogModel(entry, capability, pricing))
         // Keep a profile only when its underlying model produces text. An id
         // that does not resolve to a known model is kept rather than hidden:
         // absent capability data is not evidence the model is unusable.
         .filter((model) => !canFilter || model.supportsText);
      if (models.length === 0) {
         throw new CatalogUnavailable('Bedrock listed no text-capable inference profiles');
      }

      this.cached = models;
      this.cachedAt = this.clock();
      return models;
   }

   /**
    * Per-token prices from Portkey's open Bedrock dataset, keyed by every id a
    * profile might resolve to (see `priceKeyCandidates` in `pricing.ts`).
    *
    * Best-effort by contract: a network failure, a non-OK response, or a body
    * that does not parse resolves to an empty map, so prices simply read as
    * unknown rather than emptying or blocking the catalogue. A short timeout
    * keeps a slow feed from holding up the whole refresh.
    */
   private async fetchPricing(): Promise<Map<string, ModelPrice>> {
      return fetchPortkeyPricing(this.fetch, this.pricingUrl);
   }
}

/**
 * What a foundation model can do, keyed by the id an inference profile embeds.
 *
 * `ListFoundationModels` returns ids like `anthropic.claude-sonnet-4-20250514-v1:0`,
 * while a profile id is that with a region prefix (`us.anthropic.claude-…`).
 * Indexing by the bare model id lets a profile find its model by stripping the
 * prefix. Only text-output models are asked for, so presence in this map means
 * "produces text"; `vision` records whether it also accepts image input.
 */
interface ModelCapability {
   /** Produces text output — the requirement for a Converse chat model. */
   text: boolean;
   /** Accepts image input, surfaced to the picker as a vision badge. */
   vision: boolean;
}

function indexByModel(models: FoundationModelSummary[]): Map<string, ModelCapability> {
   const byId = new Map<string, ModelCapability>();
   for (const model of models) {
      if (!model.modelId) continue;
      const outputs = model.outputModalities ?? [];
      byId.set(model.modelId, {
         // A model with no declared output modalities is treated as text: the
         // field is optional, and absent is not evidence of "not text".
         text: outputs.length === 0 || outputs.includes('TEXT'),
         vision: (model.inputModalities ?? []).includes('IMAGE'),
      });
   }
   return byId;
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
/** A catalogue row plus the transient text-capability used to filter it. */
interface CandidateModel extends CatalogModel {
   /** The underlying model produces text (or its capability is unknown). */
   supportsText: boolean;
}

function toCatalogModel(
   entry: {
      inferenceProfileId?: string | undefined;
      inferenceProfileName?: string | undefined;
   },
   capability: Map<string, ModelCapability>,
   pricing: Map<string, ModelPrice>
): CandidateModel {
   const id = entry.inferenceProfileId!;
   // A profile id is a cross-region-routing prefix plus the bare model id
   // (`us.anthropic.claude-…`, `global.anthropic.claude-…`); the foundation
   // list and the Portkey price data key off the bare id. Strip a known routing
   // prefix to look both up. An id that does not resolve leaves capability
   // undefined (treated as "unknown") and price zero (shown as unknown).
   const modelId = stripRoutingPrefix(id);
   const known = capability.get(modelId);
   const price = priceForModel(pricing, modelId);
   return {
      id,
      displayName: entry.inferenceProfileName || id,
      provider: PROVIDER,
      tier: '',
      // Portkey's dataset carries prices but not context window; zero stays
      // "unknown" in the UI rather than an invented number.
      contextWindow: 0,
      inputCostPerM: price?.inputPerM ?? 0,
      outputCostPerM: price?.outputPerM ?? 0,
      // Converse carries tools across every family Bedrock exposes this way,
      // and Berry only keeps text models, all of which accept them.
      supportsTools: true,
      supportsVision: known?.vision ?? false,
      // Known model: keep it only if it produces text (drops embedding/image
      // models). Unknown id: keep it — absent capability data is not evidence
      // the model is unusable, and Converse is the run-time backstop.
      supportsText: known ? known.text : true,
   };
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

/**
 * Whether a profile id is on the `global.` cross-region routing family.
 *
 * These duplicate the regional (`us.`, `eu.`, …) profiles for the same models,
 * so the catalogue drops them to keep one row per model in the picker.
 */
export function isGlobalProfile(id: string): boolean {
   return id.startsWith('global.');
}
