import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   PriceBook,
   costMicrosFor,
   parsePortkeyPricing,
   priceForModel,
   type ModelPrice,
} from './pricing.ts';

/**
 * Prices, from Portkey's open Bedrock dataset. The feed is cents per token;
 * Berry speaks USD per million, and costs are computed in micros so a run's
 * cost is an integer the ledger can add.
 */

function entry(input: number, output: number, cacheWrite?: number, cacheRead?: number) {
   return {
      pricing_config: {
         pay_as_you_go: {
            request_token: { price: input },
            response_token: { price: output },
            ...(cacheWrite === undefined ? {} : { cache_write_input_token: { price: cacheWrite } }),
            ...(cacheRead === undefined ? {} : { cache_read_input_token: { price: cacheRead } }),
         },
      },
   };
}

const FEED = {
   'claude-sonnet-4-20250514': entry(0.0003, 0.0015, 0.000375, 3e-5),
   'meta.llama3-3-70b-instruct-v1:0': entry(0.000072, 0.000072),
   'broken-model': { pricing_config: { pay_as_you_go: { request_token: { price: 1 } } } },
};

function close(actual: number | null | undefined, expected: number): void {
   assert.ok(actual !== null && actual !== undefined, 'price is present');
   assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
}

test('cents per token become USD per million, cache prices included', () => {
   const prices = parsePortkeyPricing(FEED);
   const sonnet = prices.get('claude-sonnet-4-20250514');
   close(sonnet?.inputPerM, 3);
   close(sonnet?.outputPerM, 15);
   close(sonnet?.cacheWritePerM, 3.75);
   close(sonnet?.cacheReadPerM, 0.3);
   assert.equal(prices.get('meta.llama3-3-70b-instruct-v1:0')?.cacheReadPerM, null);
});

test('an entry missing a token price is skipped rather than recorded as free', () => {
   assert.equal(parsePortkeyPricing(FEED).has('broken-model'), false);
   assert.equal(parsePortkeyPricing(null).size, 0);
});

test('a routed profile id finds a price keyed by the bare, version-stripped name', () => {
   const prices = parsePortkeyPricing(FEED);
   close(priceForModel(prices, 'us.anthropic.claude-sonnet-4-20250514-v1:0')?.inputPerM, 3);
   close(priceForModel(prices, 'global.anthropic.claude-sonnet-4-20250514-v1:0')?.inputPerM, 3);
   close(priceForModel(prices, 'us.meta.llama3-3-70b-instruct-v1:0')?.inputPerM, 0.72);
   assert.equal(priceForModel(prices, 'us.unknown.model-v1:0'), undefined);
});

test('cost is integer micros over all four token kinds', () => {
   const sonnet = parsePortkeyPricing(FEED).get('claude-sonnet-4-20250514') as ModelPrice;
   const micros = costMicrosFor(sonnet, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
   });
   // 1000×3 + 500×15 + 2000×0.3 + 100×3.75
   assert.equal(micros, 11475);
});

test('a model with no published cache price is charged the input price for cache tokens', () => {
   const price: ModelPrice = { inputPerM: 2, outputPerM: 4, cacheReadPerM: null, cacheWritePerM: null };
   assert.equal(
      costMicrosFor(price, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 5 }),
      40
   );
});

test('the price book fetches once per TTL and serves the last good map on failure', async () => {
   let now = 0;
   let calls = 0;
   let fail = false;
   const fetchImpl = (async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => FEED } as Response;
   }) as unknown as typeof globalThis.fetch;
   const book = new PriceBook({ fetch: fetchImpl, ttlMs: 1000, clock: () => now });

   close((await book.priceFor('us.anthropic.claude-sonnet-4-20250514-v1:0'))?.inputPerM, 3);
   await book.priceFor('us.meta.llama3-3-70b-instruct-v1:0');
   assert.equal(calls, 1);

   now = 5000;
   fail = true;
   close((await book.priceFor('us.anthropic.claude-sonnet-4-20250514-v1:0'))?.outputPerM, 15);
   assert.equal(calls, 2);
   assert.equal(await book.priceFor('us.unknown.model-v1:0'), null);
});
