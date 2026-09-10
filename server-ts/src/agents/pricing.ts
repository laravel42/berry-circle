/**
 * What a model costs, from Portkey's open (MIT) Bedrock pricing dataset.
 *
 * One reader for two callers: the model picker shows the price, and usage
 * accounting charges it. Two parsers of the same feed would disagree the day
 * the feed changes shape, and a cost on the Usage page that differs from the
 * price in the picker is a bug report nobody can close.
 *
 * Free and unauthenticated — a keyless server-side read that introduces no
 * provider credential. https://github.com/Portkey-AI/models
 */

export const DEFAULT_PRICING_URL = 'https://configs.portkey.ai/pricing/bedrock.json';

/** How long a slow pricing feed may hold up a refresh. */
export const PRICING_TIMEOUT_MS = 5000;

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** USD per million tokens. A null cache price means the feed publishes none. */
export interface ModelPrice {
   inputPerM: number;
   outputPerM: number;
   cacheReadPerM: number | null;
   cacheWritePerM: number | null;
}

export interface PricingSource {
   priceFor(modelId: string): Promise<ModelPrice | null>;
}

export interface TokenCounts {
   inputTokens: number;
   outputTokens: number;
   cacheReadTokens: number;
   cacheWriteTokens: number;
}

/**
 * Portkey's document as a price map.
 *
 * Prices are cents per token under `pricing_config.pay_as_you_go`; cents per
 * token × 10,000 is USD per million. An entry missing either the input or the
 * output price is skipped rather than recorded as free.
 */
export function parsePortkeyPricing(body: unknown): Map<string, ModelPrice> {
   const prices = new Map<string, ModelPrice>();
   if (typeof body !== 'object' || body === null) return prices;

   for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const payg = readObject(readObject(value, 'pricing_config'), 'pay_as_you_go');
      const input = readNumber(readObject(payg, 'request_token'), 'price');
      const output = readNumber(readObject(payg, 'response_token'), 'price');
      if (input === null || output === null) continue;
      const cacheRead = readNumber(readObject(payg, 'cache_read_input_token'), 'price');
      const cacheWrite = readNumber(readObject(payg, 'cache_write_input_token'), 'price');
      prices.set(key, {
         inputPerM: input * 10_000,
         outputPerM: output * 10_000,
         cacheReadPerM: cacheRead === null ? null : cacheRead * 10_000,
         cacheWritePerM: cacheWrite === null ? null : cacheWrite * 10_000,
      });
   }
   return prices;
}

/**
 * The Portkey keys a model might be priced under.
 *
 * Portkey keys most Bedrock models by full id (`meta.llama3-3-70b-…-v1:0`) but
 * Anthropic ones by a bare, version-stripped name (`claude-sonnet-4-20250514`).
 * Full id first, then the provider-stripped body, then that without `-vN:N`.
 */
export function priceKeyCandidates(modelId: string): string[] {
   const candidates = [modelId];
   const dot = modelId.indexOf('.');
   if (dot >= 0) {
      const body = modelId.slice(dot + 1);
      candidates.push(body);
      candidates.push(body.replace(/-v\d+(:\d+)?$/, ''));
   }
   return candidates;
}

/** The price for a profile or bare model id, or undefined when unpublished. */
export function priceForModel(
   prices: Map<string, ModelPrice>,
   modelId: string
): ModelPrice | undefined {
   for (const candidate of priceKeyCandidates(stripRoutingPrefix(modelId))) {
      const found = prices.get(candidate);
      if (found) return found;
   }
   return undefined;
}

/**
 * Cost in USD micros. Tokens × USD-per-million is already micros, so there is
 * no scaling, only rounding once at the end.
 *
 * A model with no published cache price is charged its input price for cache
 * tokens: an over-estimate, not zero. Reporting cached work as free would
 * understate exactly the runs that read the most context.
 */
export function costMicrosFor(price: ModelPrice, tokens: TokenCounts): number {
   return Math.round(
      tokens.inputTokens * price.inputPerM +
         tokens.outputTokens * price.outputPerM +
         tokens.cacheReadTokens * (price.cacheReadPerM ?? price.inputPerM) +
         tokens.cacheWriteTokens * (price.cacheWritePerM ?? price.inputPerM)
   );
}

/**
 * The feed, fetched once. Best-effort by contract: a network failure, a
 * non-OK answer or a body that does not parse is an empty map.
 */
export async function fetchPortkeyPricing(
   fetchImpl: typeof globalThis.fetch,
   url: string = DEFAULT_PRICING_URL
): Promise<Map<string, ModelPrice>> {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);
   try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return new Map();
      return parsePortkeyPricing(await response.json());
   } catch {
      return new Map();
   } finally {
      clearTimeout(timer);
   }
}

export interface PriceBookOptions {
   fetch?: typeof globalThis.fetch;
   url?: string;
   ttlMs?: number;
   clock?: () => number;
}

/**
 * A cached price map for the write path.
 *
 * A failed refresh keeps the last good map. Prices move on the provider's
 * schedule, and a feed outage should leave a run priced at yesterday's rate
 * rather than unpriced.
 */
export class PriceBook implements PricingSource {
   readonly #fetch: typeof globalThis.fetch;
   readonly #url: string;
   readonly #ttlMs: number;
   readonly #clock: () => number;
   #prices: Map<string, ModelPrice> | null = null;
   #fetchedAt = 0;
   #inFlight: Promise<Map<string, ModelPrice>> | null = null;

   constructor(options: PriceBookOptions = {}) {
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#url = options.url ?? DEFAULT_PRICING_URL;
      this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
      this.#clock = options.clock ?? Date.now;
   }

   async priceFor(modelId: string): Promise<ModelPrice | null> {
      const prices = await this.#current();
      return priceForModel(prices, modelId) ?? null;
   }

   async #current(): Promise<Map<string, ModelPrice>> {
      if (this.#prices && this.#clock() - this.#fetchedAt < this.#ttlMs) return this.#prices;
      this.#inFlight ??= fetchPortkeyPricing(this.#fetch, this.#url).finally(() => {
         this.#inFlight = null;
      });
      const fresh = await this.#inFlight;
      // An empty answer is a failed fetch, not a feed with no models in it.
      if (fresh.size > 0 || !this.#prices) {
         this.#prices = fresh;
      }
      this.#fetchedAt = this.#clock();
      return this.#prices;
   }
}

/**
 * The cross-region routing prefixes Bedrock puts on a system inference
 * profile. A profile id is one of these plus the bare foundation-model id.
 */
const ROUTING_PREFIXES = ['us-gov', 'us', 'eu', 'apac', 'apne', 'global'];

/** Strips a known routing prefix (`us.`, `global.`, …) from a profile id. */
export function stripRoutingPrefix(id: string): string {
   for (const prefix of ROUTING_PREFIXES) {
      if (id.startsWith(`${prefix}.`)) return id.slice(prefix.length + 1);
   }
   return id;
}

function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
   if (typeof value !== 'object' || value === null) return undefined;
   const child = (value as Record<string, unknown>)[key];
   return typeof child === 'object' && child !== null
      ? (child as Record<string, unknown>)
      : undefined;
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | null {
   const field = value?.[key];
   return typeof field === 'number' && Number.isFinite(field) ? field : null;
}
