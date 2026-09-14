import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   CatalogUnavailable,
   ModelCatalog,
   normalizeModelId,
   resolveModel,
   type CatalogModel,
} from './catalog.ts';

/**
 * The model catalogue. Driven against a fake Bedrock client rather than the
 * real one, because what is worth testing here is the caching and the failure
 * behaviour — a live catalogue would test AWS's uptime instead.
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

test('a repeated provider prefix is stripped, and a real one is not', () => {
   // The quirk is inherited from the catalogue before Bedrock, and rows written
   // then still carry it until migration 047 rewrites them: dropping this would
   // make every one of those pairings unavailable in the meantime.
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

/**
 * A Bedrock client that lists the given profiles, counting how often a refresh
 * happens. A refresh now issues two commands — `ListInferenceProfiles` and
 * `ListFoundationModels` — so the profile command is what a refresh is counted
 * by; the foundation command is answered (with no summaries here, which leaves
 * the catalogue unfiltered) without inflating the count.
 */
function listing(profiles: Array<{ inferenceProfileId?: string; inferenceProfileName?: string }>) {
   let calls = 0;
   const client = {
      async send(command: { constructor: { name: string } }) {
         if (command.constructor.name === 'ListFoundationModelsCommand') {
            return { modelSummaries: [] };
         }
         calls += 1;
         return { inferenceProfileSummaries: profiles };
      },
   };
   return { client: client as never, calls: () => calls };
}

/** A Bedrock client that always refuses. */
function refusing() {
   return {
      async send() {
         throw new Error('AccessDeniedException');
      },
   } as never;
}

/**
 * A `fetch` that answers the Portkey pricing feed with the given document. The
 * default is an empty object, so a catalogue built without a specific price
 * body reads every model as unpriced — and no test ever reaches the network.
 */
function pricingFetch(body: Record<string, unknown> = {}): typeof globalThis.fetch {
   return (async () =>
      ({ ok: true, json: async () => body }) as Response) as typeof globalThis.fetch;
}

function catalog(
   bedrock: never,
   ttlMs = 60_000,
   clock?: () => number,
   fetchImpl: typeof globalThis.fetch = pricingFetch()
) {
   return new ModelCatalog({
      region: 'us-east-1',
      bedrock,
      fetch: fetchImpl,
      ttlMs,
      ...(clock ? { clock } : {}),
   });
}

test('the catalogue is listed once and served from cache until it goes stale', async () => {
   const source = listing([{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }]);
   let now = 0;
   const models = catalog(source.client, 1000, () => now);

   await models.list();
   await models.list();
   assert.equal(source.calls(), 1, 'a warm cache should not ask again');

   now = 2000;
   await models.list();
   assert.equal(source.calls(), 2, 'a stale cache should');
});

test('concurrent readers on a cold cache cost one round trip', async () => {
   // A picker opened by ten people should cost one call, not ten.
   const source = listing([{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }]);
   const models = catalog(source.client);
   await Promise.all([models.list(), models.list(), models.list()]);
   assert.equal(source.calls(), 1);
});

test('a failed refresh serves the last good list rather than emptying the picker', async () => {
   let fail = false;
   let now = 0;
   const client = {
      async send() {
         if (fail) throw new Error('ThrottlingException');
         return { inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.x' }] };
      },
   } as never;
   const models = catalog(client, 1000, () => now);

   assert.equal((await models.list()).length, 1);
   fail = true;
   now = 2000;
   assert.equal((await models.list()).length, 1, 'the stale list beats an empty picker');
});

test('a first listing that fails throws rather than reporting no models', async () => {
   // "Bedrock cannot be reached" and "there are no models" are different
   // answers, and only one of them is true.
   const models = catalog(refusing());
   await assert.rejects(models.list(), CatalogUnavailable);
});

test('an account with no profiles is reported as unavailable, not as empty', async () => {
   const models = catalog(listing([]).client);
   await assert.rejects(models.list(), CatalogUnavailable);
});

test('a profile carries what the picker shows about it', async () => {
   const models = catalog(
      listing([
         {
            inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
            inferenceProfileName: 'Claude Sonnet 4',
         },
      ]).client
   );
   const [model] = await models.list();

   assert.equal(model!.id, 'us.anthropic.claude-sonnet-4-20250514-v1:0');
   assert.equal(model!.displayName, 'Claude Sonnet 4');
   assert.equal(model!.provider, 'bedrock');
   // Bedrock publishes neither on this API. Zero is a fact the UI can render as
   // unknown; a plausible guess would be shown as though it were true.
   assert.equal(model!.contextWindow, 0);
   assert.equal(model!.inputCostPerM, 0);
});

test('a profile with no id is dropped rather than listed as blank', async () => {
   const models = catalog(
      listing([{ inferenceProfileName: 'nameless' }, { inferenceProfileId: 'us.anthropic.x' }]).client
   );
   assert.deepEqual((await models.list()).map((m) => m.id), ['us.anthropic.x']);
});

/**
 * A Bedrock client answering both refresh commands: the given profiles, and
 * the given foundation-model summaries the catalogue filters against.
 */
function listingWithModels(
   profiles: Array<{ inferenceProfileId?: string; inferenceProfileName?: string }>,
   modelSummaries: Array<{
      modelId?: string;
      outputModalities?: string[];
      inputModalities?: string[];
   }>
) {
   const client = {
      async send(command: { constructor: { name: string } }) {
         if (command.constructor.name === 'ListFoundationModelsCommand') {
            return { modelSummaries };
         }
         return { inferenceProfileSummaries: profiles };
      },
   };
   return client as never;
}

test('non-text models are filtered out and image input surfaces as vision', async () => {
   const models = catalog(
      listingWithModels(
         [
            { inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' },
            { inferenceProfileId: 'us.meta.llama3-3-70b-instruct-v1:0' },
            { inferenceProfileId: 'us.amazon.titan-embed-text-v2:0' },
            { inferenceProfileId: 'us.amazon.nova-canvas-v1:0' },
         ],
         [
            {
               modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
               outputModalities: ['TEXT'],
               inputModalities: ['TEXT', 'IMAGE'],
            },
            { modelId: 'meta.llama3-3-70b-instruct-v1:0', outputModalities: ['TEXT'], inputModalities: ['TEXT'] },
            { modelId: 'amazon.titan-embed-text-v2:0', outputModalities: ['EMBEDDING'], inputModalities: ['TEXT'] },
            { modelId: 'amazon.nova-canvas-v1:0', outputModalities: ['IMAGE'], inputModalities: ['TEXT'] },
         ]
      )
   );

   const listed = await models.list();
   // The embedding and image models are gone; the two text models remain.
   assert.deepEqual(
      listed.map((m) => m.id).sort(),
      [
         'us.anthropic.claude-sonnet-4-20250514-v1:0',
         'us.meta.llama3-3-70b-instruct-v1:0',
      ]
   );
   // Claude accepts image input, so it reads as a vision model; Llama does not.
   const claude = listed.find((m) => m.id.includes('anthropic'));
   const llama = listed.find((m) => m.id.includes('meta'));
   assert.equal(claude!.supportsVision, true);
   assert.equal(llama!.supportsVision, false);
   // Every surviving model still advertises tools for the agent runtime.
   assert.ok(listed.every((m) => m.supportsTools));
});

test('a profile whose model id does not resolve is kept rather than dropped', async () => {
   // An unknown id (no matching foundation model) is not evidence of "unusable":
   // keep it and let the run-time Converse call be the backstop.
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.somefuture.model-v1:0' }],
         [{ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', outputModalities: ['TEXT'] }]
      )
   );
   const listed = await models.list();
   assert.deepEqual(listed.map((m) => m.id), ['us.somefuture.model-v1:0']);
});

test('an unavailable foundation-model list leaves the profiles unfiltered', async () => {
   // ListFoundationModels failing must not empty the picker: with no capability
   // data the catalogue cannot filter, so every profile is listed.
   const client = {
      async send(command: { constructor: { name: string } }) {
         if (command.constructor.name === 'ListFoundationModelsCommand') {
            throw new Error('AccessDeniedException');
         }
         return {
            inferenceProfileSummaries: [
               { inferenceProfileId: 'us.amazon.titan-embed-text-v2:0' },
            ],
         };
      },
   } as never;
   const models = catalog(client);
   // Even an embedding profile survives when there is nothing to filter with.
   assert.deepEqual((await models.list()).map((m) => m.id), ['us.amazon.titan-embed-text-v2:0']);
});

test('global. profiles are excluded, leaving the regional profile', async () => {
   // Bedrock lists both a regional and a global profile for the same model. The
   // catalogue keeps the regional one and drops the global duplicate, so the
   // picker shows one row per model rather than two.
   const models = catalog(
      listingWithModels(
         [
            { inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
            { inferenceProfileId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' },
         ],
         [
            {
               modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
               outputModalities: ['TEXT'],
               inputModalities: ['TEXT', 'IMAGE'],
            },
         ]
      )
   );
   const listed = await models.list();
   assert.deepEqual(
      listed.map((m) => m.id),
      ['us.anthropic.claude-sonnet-4-5-20250929-v1:0']
   );
});

test('a us. profile resolves its capability through the stripped prefix', async () => {
   // The routing prefix must be stripped for the capability lookup to hit; a
   // naive two-or-three-letter strip once left these profiles unmatched.
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }],
         [
            {
               modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
               outputModalities: ['TEXT'],
               inputModalities: ['TEXT', 'IMAGE'],
            },
         ]
      )
   );
   const [model] = await models.list();
   assert.equal(model!.supportsVision, true);
});

/** A Portkey pricing entry: cents-per-token for input and output. */
function portkeyEntry(inputCents: number, outputCents: number) {
   return {
      pricing_config: {
         pay_as_you_go: {
            request_token: { price: inputCents },
            response_token: { price: outputCents },
         },
      },
   };
}

test('prices come from the Portkey feed, converted from cents/token to per million', async () => {
   // Anthropic is keyed by a bare, version-stripped name in Portkey; the join
   // must find it from the full profile id `us.anthropic.claude-…-v1:0`.
   const fetchImpl = pricingFetch({
      'claude-sonnet-4-20250514': portkeyEntry(0.0003, 0.0015),
   });
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }],
         [{ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', outputModalities: ['TEXT'] }]
      ),
      60_000,
      undefined,
      fetchImpl
   );

   const [model] = await models.list();
   // 0.0003 cents/token × 10,000 = $3/M; 0.0015 × 10,000 = $15/M. Compared with
   // a tolerance because the ×10,000 scaling is not exact in binary floating
   // point (3 comes back as 2.9999999999999996).
   assert.ok(Math.abs(model!.inputCostPerM - 3) < 1e-6, `input ~$3/M, got ${model!.inputCostPerM}`);
   assert.ok(
      Math.abs(model!.outputCostPerM - 15) < 1e-6,
      `output ~$15/M, got ${model!.outputCostPerM}`
   );
});

test('a model Portkey keys by its full id (Meta, DeepSeek) is priced too', async () => {
   const fetchImpl = pricingFetch({
      'meta.llama3-3-70b-instruct-v1:0': portkeyEntry(0.0000072, 0.0000072),
   });
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.meta.llama3-3-70b-instruct-v1:0' }],
         [{ modelId: 'meta.llama3-3-70b-instruct-v1:0', outputModalities: ['TEXT'] }]
      ),
      60_000,
      undefined,
      fetchImpl
   );

   const [model] = await models.list();
   assert.ok(model!.inputCostPerM > 0, 'the full-id keyed model is priced');
   assert.ok(
      Math.abs(model!.outputCostPerM - 0.072) < 1e-6,
      `output ~$0.072/M, got ${model!.outputCostPerM}`
   );
});

test('a model absent from the Portkey feed reads as unknown, not free', async () => {
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.amazon.nova-premier-v1:0' }],
         [{ modelId: 'amazon.nova-premier-v1:0', outputModalities: ['TEXT'] }]
      ),
      60_000,
      undefined,
      pricingFetch({ 'claude-sonnet-4-20250514': portkeyEntry(0.0003, 0.0015) })
   );
   const [model] = await models.list();
   assert.equal(model!.inputCostPerM, 0);
   assert.equal(model!.outputCostPerM, 0);
});

test('a pricing feed failure leaves prices unknown without emptying the catalogue', async () => {
   const failing = (async () => {
      throw new Error('network down');
   }) as typeof globalThis.fetch;
   const models = catalog(
      listingWithModels(
         [{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }],
         [{ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', outputModalities: ['TEXT'] }]
      ),
      60_000,
      undefined,
      failing
   );
   const listed = await models.list();
   assert.equal(listed.length, 1, 'the model is still listed');
   assert.equal(listed[0]!.inputCostPerM, 0, 'its price is just unknown');
});
