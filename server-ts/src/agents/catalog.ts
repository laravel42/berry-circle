/**
 * The models an agent can be switched to.
 *
 * Ported from server/internal/modelcatalog, minus the half that made it
 * complicated. There, the runtime reported a catalogue with its OpenRouter
 * entries compiled into the binary, so they went stale and a working pairing
 * read as unavailable; the Go package exists to splice OpenRouter's live list
 * over them and keep the runtime's other providers.
 *
 * Under ADK there are no other providers. Berry talks to OpenRouter, so the
 * live list is the whole catalogue and there is nothing to merge.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
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
   baseUrl?: string;
   /**
    * Bounds how stale the list may be. It changes on OpenRouter's release
    * schedule rather than Berry's, so a short cache costs nothing and spares
    * every picker render a 400-model fetch.
    */
   ttlMs?: number;
   fetch?: typeof globalThis.fetch;
   clock?: () => number;
}

/** The provider every model here is served by. */
export const PROVIDER = 'openrouter';

export class ModelCatalog {
   private readonly baseUrl: string;
   private readonly ttlMs: number;
   private readonly fetch: typeof globalThis.fetch;
   private readonly clock: () => number;
   private cached: CatalogModel[] | null = null;
   private cachedAt = 0;
   private inFlight: Promise<CatalogModel[]> | null = null;

   constructor(options: CatalogOptions = {}) {
      this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
      this.fetch = options.fetch ?? globalThis.fetch;
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
      const response = await this.fetch(`${this.baseUrl}/models`, {
         headers: { accept: 'application/json' },
      });
      if (!response.ok) {
         throw new CatalogUnavailable(`OpenRouter model catalogue returned ${response.status}`);
      }
      const payload = (await response.json()) as { data?: WireModel[] };
      const models = (payload.data ?? []).filter((entry) => entry.id).map(toCatalogModel);
      if (models.length === 0) throw new CatalogUnavailable('OpenRouter listed no models');

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

interface WireModel {
   id?: string;
   name?: string;
   context_length?: number;
   architecture?: { input_modalities?: string[] };
   pricing?: { prompt?: string; completion?: string };
   supported_parameters?: string[];
}

function toCatalogModel(entry: WireModel): CatalogModel {
   return {
      id: entry.id!,
      displayName: entry.name || entry.id!,
      provider: PROVIDER,
      // OpenRouter publishes no tier. Empty rather than invented: the field
      // exists because the OpenFang catalogue had one, and a guess here would
      // be shown in a column people read as fact.
      tier: '',
      contextWindow: entry.context_length ?? 0,
      inputCostPerM: perMillion(entry.pricing?.prompt),
      outputCostPerM: perMillion(entry.pricing?.completion),
      supportsTools: (entry.supported_parameters ?? []).includes('tools'),
      supportsVision: (entry.architecture?.input_modalities ?? []).includes('image'),
   };
}

/**
 * A per-token price string as the per-million figure the product displays.
 *
 * OpenRouter quotes prices as strings ("0.000001") because they are exact
 * decimals, and an unparsable one becomes 0 rather than failing the whole
 * catalogue: a missing price costs one column, a rejected catalogue costs the
 * picker.
 */
export function perMillion(price: string | undefined): number {
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
 * Kept from the Go adapter because the stored pairings still carry it: agents
 * configured against the OpenFang catalogue hold ("openrouter",
 * "openrouter/anthropic/claude-sonnet-4"), and dropping the normalisation
 * would make every one of them read as unavailable.
 */
export function normalizeModelId(provider: string, id: string): string {
   if (!provider || !id) return id;
   return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}
