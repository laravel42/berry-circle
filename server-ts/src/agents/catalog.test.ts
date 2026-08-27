import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   CatalogUnavailable,
   ModelCatalog,
   normalizeModelId,
   perMillion,
   resolveModel,
   type CatalogModel,
} from './catalog.ts';

/**
 * The model catalogue. Driven against a fake fetch rather than OpenRouter,
 * because what is worth testing here is the caching and the failure
 * behaviour — a live catalogue would test OpenRouter's uptime instead.
 */

function wire(id: string, prompt = '0.000003', completion = '0.000015') {
   return {
      id,
      name: id.toUpperCase(),
      context_length: 200_000,
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt, completion },
      supported_parameters: ['tools'],
   };
}

function fakeFetch(pages: Array<{ ok?: boolean; status?: number; data?: unknown[] }>) {
   let call = 0;
   const fetcher = (async () => {
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return {
         ok: page.ok ?? true,
         status: page.status ?? 200,
         json: async () => ({ data: page.data ?? [] }),
      } as Response;
   }) as unknown as typeof globalThis.fetch;
   return { fetcher, calls: () => call };
}

test('a per-token price becomes the per-million figure the product shows', () => {
   assert.equal(perMillion('0.000003'), 3);
   assert.equal(perMillion('0.00000000021'), 0.00021);
   assert.equal(perMillion('0'), 0);
   // An unparsable price costs one column; a rejected catalogue costs the
   // picker, so this is 0 rather than a throw.
   assert.equal(perMillion(undefined), 0);
   assert.equal(perMillion('free'), 0);
});

test('a repeated provider prefix is stripped, and a real one is not', () => {
   // The quirk is inherited from the OpenFang catalogue, and stored pairings
   // still carry it: dropping this would make every one of them unavailable.
   assert.equal(normalizeModelId('openrouter', 'openrouter/anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
   assert.equal(normalizeModelId('openrouter', 'anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
   assert.equal(normalizeModelId('anthropic', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
   assert.equal(normalizeModelId('', 'x'), 'x');
});

test('a pairing resolves through the prefix quirk from either side', () => {
   const models: CatalogModel[] = [
      {
         id: 'anthropic/claude-sonnet-4.5',
         displayName: 'Claude Sonnet 4.5',
         provider: 'openrouter',
         tier: '',
         contextWindow: 200_000,
         inputCostPerM: 3,
         outputCostPerM: 15,
         supportsTools: true,
         supportsVision: true,
      },
   ];
   assert.ok(resolveModel(models, 'openrouter', 'anthropic/claude-sonnet-4.5'));
   assert.ok(resolveModel(models, 'openrouter', 'openrouter/anthropic/claude-sonnet-4.5'));
   // A provider this deployment does not serve resolves to nothing, which is
   // what stops an agent being pointed at a model that cannot run.
   assert.equal(resolveModel(models, 'anthropic', 'claude-sonnet-4.5'), undefined);
   assert.equal(resolveModel(models, 'openrouter', 'openai/gpt-5'), undefined);
});

test('the catalogue is fetched once and served from cache until it goes stale', async () => {
   let now = 1_000;
   const { fetcher, calls } = fakeFetch([{ data: [wire('a/one')] }]);
   const catalog = new ModelCatalog({ fetch: fetcher, clock: () => now, ttlMs: 100 });

   assert.equal((await catalog.list()).length, 1);
   await catalog.list();
   assert.equal(calls(), 1, 'a warm cache does not refetch');

   now += 101;
   await catalog.list();
   assert.equal(calls(), 2, 'a stale cache refetches');
});

test('concurrent readers on a cold cache cost one round trip', async () => {
   const { fetcher, calls } = fakeFetch([{ data: [wire('a/one')] }]);
   const catalog = new ModelCatalog({ fetch: fetcher });
   // A picker opened by ten people should not cost ten fetches of a
   // 400-model list.
   await Promise.all(Array.from({ length: 10 }, () => catalog.list()));
   assert.equal(calls(), 1);
});

test('a failed refresh serves the last good list rather than emptying the picker', async () => {
   let now = 1_000;
   const { fetcher } = fakeFetch([{ data: [wire('a/one')] }, { ok: false, status: 503 }]);
   const catalog = new ModelCatalog({ fetch: fetcher, clock: () => now, ttlMs: 10 });

   assert.equal((await catalog.list()).length, 1);
   now += 11;
   const served = await catalog.list();
   assert.equal(served.length, 1, 'a transient failure must not empty a picker that just worked');
});

test('a first fetch that fails throws rather than reporting no models', async () => {
   // "No models exist" and "this server cannot ask" are different answers, and
   // only one of them would be true.
   const { fetcher } = fakeFetch([{ ok: false, status: 500 }]);
   await assert.rejects(() => new ModelCatalog({ fetch: fetcher }).list(), CatalogUnavailable);

   const empty = fakeFetch([{ data: [] }]);
   await assert.rejects(() => new ModelCatalog({ fetch: empty.fetcher }).list(), CatalogUnavailable);
});

test('a model carries what the picker shows about it', async () => {
   const { fetcher } = fakeFetch([{ data: [wire('anthropic/claude-sonnet-4.5')] }]);
   const [model] = await new ModelCatalog({ fetch: fetcher }).list();

   assert.deepEqual(model, {
      id: 'anthropic/claude-sonnet-4.5',
      displayName: 'ANTHROPIC/CLAUDE-SONNET-4.5',
      provider: 'openrouter',
      // OpenRouter publishes no tier, and inventing one would put a guess in a
      // column people read as fact.
      tier: '',
      contextWindow: 200_000,
      inputCostPerM: 3,
      outputCostPerM: 15,
      supportsTools: true,
      supportsVision: true,
   });
});

test('a model with no id is dropped rather than listed as blank', async () => {
   const { fetcher } = fakeFetch([{ data: [{ name: 'nameless' }, wire('a/one')] }]);
   const models = await new ModelCatalog({ fetch: fetcher }).list();
   assert.deepEqual(
      models.map((model) => model.id),
      ['a/one']
   );
});
