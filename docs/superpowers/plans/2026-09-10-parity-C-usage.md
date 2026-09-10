# Parity C — Usage and Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every model-usage event with its cost, roll it up by hour, and serve it as issue, agent, runtime and workspace usage plus a workspace dashboard, with Usage and Dashboard pages and usage panels in the web app.

**Architecture:** One write path: `recordTaskUsage(sql, …)` in `server-ts/src/usage/record.ts` prices the event from the Portkey price feed the model catalogue already reads. In one transaction it inserts a `task_usage` row, upserts `task_usage_hourly`, recomputes the run's token and cost totals, and publishes `usage.recorded` to `outbox_events`. Workstream A calls it on `task.usage`. Until A lands, the in-process executor calls it after each run. Reads are workspace-scoped SQL over the two tables plus `runs` and `issues`, served by `/api/v1/usage` and `/api/v1/dashboard`. The frontend renders them with Zod v3 schemas, recharts and the existing shell.

**Tech Stack:** Node 22 `--experimental-strip-types`, Hono, postgres.js, Zod v4 (server), `node --test`; Next.js 15, React 19, Zod v3, recharts 2, zustand (frontend).

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` — section 4 (Usage and cost), with sections 2.2 (the `task.usage` lifecycle event), 10 and 11.

## Global Constraints

- Migrations for this workstream use numbers **080–084** only. Forward-only. Never edit an applied migration.
- Every new table carries `workspace_id`. Every new mount goes through the existing workspace guard (`mountWorkspaceScope` in `server-ts/src/mounts/shared.ts`) and is added to `server-ts/src/mounts/cross-tenant-leakage.test.ts`.
- Server: no emitted TS syntax (no enums, namespaces, parameter properties). Use Zod v4 and relative imports with the `.ts` extension. Use `import type` for types. No `any`, no `!` on indexed reads. Match the surrounding style: 3-space indent, single quotes.
- Frontend: Zod v3 (`zod` `^3.24.2`), Prettier 3-space, single quotes, `@/*` imports. Gates: `pnpm lint` and `pnpm build:check`. There is no frontend test runner, so never claim frontend tests.
- Database-backed server tests self-skip when `BERRY_TEST_DATABASE_URL` is unset.
- Realtime goes through `outbox_events` and the existing SSE hub. No WebSocket.
- Clean-room: never copy multica source, schema text, copy or UI. Implement behaviour only. Web only. No new integrations.
- Shared names this plan **owns and exports**, exactly: table `task_usage`, table `task_usage_hourly`, and `recordTaskUsage(sql, { runId, workspaceId, agentId, runtimeId?: string, model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }): Promise<void>` in `server-ts/src/usage/record.ts`.
- Shared names this plan **does not define**: `TaskEnvelope`, `LifecycleEvent`, `enqueueTask`, `runCompletion`, `registerAgentTool`, `agent_runtimes`, `runtime_profiles` (all workstream A). C must not depend on A being merged. Tests call `recordTaskUsage` directly. Runtime reads use `to_regclass('public.agent_runtimes')` so they work before and after A.
- Rail seam (owned by workstream I): C appends **one** `ShellRouteDef` + `SidebarItemKey` + `DEFAULT_ORDER` slot + `customize-sidebar-dialog` item per page it ships (`usage`, `dashboard`), and never touches the `analytics` entries (I removes those).
- Commits: `type(scope): imperative summary`, scope `server-ts` or `frontend`. End each commit with the session's `Co-Authored-By` line. Do not push.
- Money is USD **micros** (`costMicros`, integer) everywhere on the wire, matching `runs.cost_micros`. Tokens are integers.

## File Structure

**Server — create**
- `server-ts/src/agents/pricing.ts` — Portkey price feed: parse (including cache prices), key matching, `costMicrosFor`, and `PriceBook` (a cached `PricingSource`). One source for prices, shared by the catalogue and usage.
- `server-ts/src/agents/pricing.test.ts` — offline tests.
- `server-ts/migrations/080_task_usage.up.sql` — `task_usage`, `task_usage_hourly`.
- `server-ts/src/usage/record.ts` — `recordTaskUsage`, `configureUsagePricing`, `taskUsageInputSchema`, `UsageRunMismatch`.
- `server-ts/src/usage/record.test.ts` — offline validation test plus DB-gated write tests.
- `server-ts/src/usage/test-fixtures.ts` — `seedUsageWorld`, `addRun`, `finishRun`, `cleanupUsageWorld`, `scopeOf` (a helper module, not a test file, so the test glob does not run it).
- `server-ts/src/usage/in-process.ts` — `usageRecordFor`, which maps an accounting snapshot to one `recordTaskUsage` input.
- `server-ts/src/usage/in-process.test.ts` — offline.
- `server-ts/src/usage/queries.ts` — every read: `usageWindow`, `workspaceUsage`, `agentUsage`, `runtimeUsage`, `runtimeVisible`, `issueUsage`, `issueInWorkspace`, `dashboardOverview`.
- `server-ts/src/usage/queries.test.ts` — DB-gated.
- `server-ts/src/mounts/usage.ts` — `/api/v1/usage` and `/api/v1/dashboard`.
- `server-ts/src/mounts/usage.test.ts` — DB-gated, real app.

**Server — modify**
- `server-ts/src/agents/catalog.ts` — import pricing from `pricing.ts`, delete the local copies.
- `server-ts/src/agents/runtime/plugins/accounting.ts` (+ `.test.ts`) — count cache read and write tokens.
- `server-ts/src/agents/runtime/scripted-model.ts` — scripted turns may carry cache tokens.
- `server-ts/src/agents/executor.ts` — record usage after every terminal write (in-process path, until A).
- `server-ts/src/runs/ledger.ts` — `completeSuccess` must not erase usage already recorded.
- `server-ts/src/realtime/replay.ts` (+ `replay.test.ts`) — add `usage.recorded` to `WORKSPACE_TOPICS`. The `/api/v1/events?workspaceId=` stream reads `outbox_events` filtered to exactly that list, so a topic missing from it never reaches a browser.
- `server-ts/src/index.ts` — configure pricing, pass `onUsageError`, register `usageMounts`.
- `server-ts/src/mounts/cross-tenant-leakage.test.ts` — the new mounts.
- `server-ts/SCOPE.md` — served prefixes.

**Frontend — create**
- `frontend/lib/usage.ts` — schemas, fetchers, formatters.
- `frontend/components/common/usage/use-usage.ts` — load, error and refresh on `usage.recorded`.
- `frontend/components/common/usage/usage-tiles.tsx`, `usage-daily-chart.tsx`, `usage-breakdown-table.tsx`, `usage-overview.tsx`, `dashboard-overview.tsx`, `issue-usage-section.tsx`, `agent-usage-tab.tsx`, `runtime-usage-panel.tsx`.
- `frontend/components/layout/headers/usage/header.tsx`, `frontend/components/layout/headers/dashboard/header.tsx`.
- `frontend/app/[orgId]/usage/page.tsx`, `frontend/app/[orgId]/dashboard/page.tsx`.

**Frontend — modify**
- `frontend/components/layout/shell/shell-routes.ts`, `frontend/store/sidebar-prefs-store.ts`, `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx` — rail items.
- `frontend/components/common/issues/details/issue-properties-panel.tsx` — the Usage section.
- `frontend/components/common/agents/agent-details.tsx` — the `usage` tab.

## Wire contract (pinned; Tasks 4–9 rely on it)

```
UsageBucket  = { key: string, events: number, unpricedEvents: number, inputTokens: number,
                 outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number,
                 costMicros: number }            // costMicros sums priced events only
AgentBucket  = UsageBucket & { agentName: string }   // key = agentId
Window       = { currency: 'USD', days: number, from: string, to: string }   // RFC 3339, UTC days

GET /api/v1/usage/:workspaceId/summary?days=30
  → Window & { totals: UsageBucket, daily: UsageBucket[] (key YYYY-MM-DD, zero-filled),
               byAgent: AgentBucket[], byModel: UsageBucket[] (key = model) }
GET /api/v1/usage/:workspaceId/agents/:agentId?days=30
  → Window & { totals, daily, byModel }
GET /api/v1/usage/:workspaceId/runtimes/:runtimeId?days=30     (runtimeId = uuid | 'default')
  → Window & { totals, daily, byAgent, byHour: UsageBucket[] (key '00'..'23' UTC, 24 rows) }
GET /api/v1/usage/:workspaceId/issues/:issueId
  → { currency: 'USD', totals, byRun: UsageBucket[] (key = runId), byModel }
GET /api/v1/dashboard/:workspaceId/overview?days=30
  → Window & { usageDaily: UsageBucket[],
               runsDaily: { day, total, succeeded, failed, cancelled }[],
               failuresByAgent: { agentId, agentName, failed, total }[],
               runCounts: { queued, running, succeeded, failed, cancelled },
               workingAgents: { runId, agentId, agentName, issueId, issueTitle, startedAt|null }[],
               taskSnapshot: Record<string, number> }   // backlog, todo, inProgress, inReview, blocked, done, cancelled (+ any other status)
Errors: 401 no session; 404 foreign/absent workspace, agent, issue or runtime;
        422 VALIDATION_FAILED for days outside 1..90 or an unknown query parameter.
Realtime: workspace-stream frame type 'usage.recorded', aggregateType 'run', payload
  { runId, issueId, agentId, runtimeId, model, inputTokens, outputTokens, cacheReadTokens,
    cacheWriteTokens, costMicros|null }
  Delivered by /api/v1/events?workspaceId= only because Task 2 adds 'usage.recorded'
  to WORKSPACE_TOPICS in server-ts/src/realtime/replay.ts.
```

## Task order and parallelism

1 → 2 → 3 (write path). 4 → 5 need 2 (tables). 6 can start at once, against the pinned contract above. 7, 8 and 9 need 6. Two subagents: one runs 1–5 (server), the other runs 6–9 (frontend), and they meet at the manual check in Task 9.

---

### Task 1: One price source for the catalogue and for usage

**Files:**
- Create: `server-ts/src/agents/pricing.ts`
- Create: `server-ts/src/agents/pricing.test.ts`
- Modify: `server-ts/src/agents/catalog.ts` (delete `DEFAULT_PRICING_URL`, `PRICING_TIMEOUT_MS`, `ModelPricing`, `parsePricing`, `priceKeyCandidates`, `priceForModel`, `readObject`, `readNumber`, `ROUTING_PREFIXES`, `stripRoutingPrefix`; change `fetchPricing` and `toCatalogModel`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ModelPrice { inputPerM: number; outputPerM: number; cacheReadPerM: number | null; cacheWritePerM: number | null }` (USD per million tokens)
  - `interface PricingSource { priceFor(modelId: string): Promise<ModelPrice | null> }`
  - `interface TokenCounts { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }`
  - `parsePortkeyPricing(body: unknown): Map<string, ModelPrice>`
  - `priceForModel(prices: Map<string, ModelPrice>, modelId: string): ModelPrice | undefined` (accepts a profile id such as `us.anthropic…` or a bare model id)
  - `costMicrosFor(price: ModelPrice, tokens: TokenCounts): number`
  - `fetchPortkeyPricing(fetchImpl: typeof globalThis.fetch, url?: string): Promise<Map<string, ModelPrice>>`
  - `stripRoutingPrefix(id: string): string` (moved here; `catalog.ts` re-exports it)
  - `class PriceBook implements PricingSource` with constructor `{ fetch?, url?, ttlMs?, clock? }`
  - `DEFAULT_PRICING_URL`

- [ ] **Step 1: Write the failing test**

`server-ts/src/agents/pricing.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/pricing.test.ts`
Expected: FAIL, `Cannot find module … pricing.ts`.

- [ ] **Step 3: Write the implementation**

`server-ts/src/agents/pricing.ts`:

```ts
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
```

Then edit `server-ts/src/agents/catalog.ts`:

1. Below the existing imports, add:
   ```ts
   import {
      DEFAULT_PRICING_URL,
      fetchPortkeyPricing,
      priceForModel,
      stripRoutingPrefix,
      type ModelPrice,
   } from './pricing.ts';

   export { stripRoutingPrefix } from './pricing.ts';
   ```
2. Delete the local `const DEFAULT_PRICING_URL = …` (the comment block above it stays and now describes the import).
3. Replace the body of `private async fetchPricing(): Promise<Map<string, ModelPricing>>` with:
   ```ts
   private async fetchPricing(): Promise<Map<string, ModelPrice>> {
      return fetchPortkeyPricing(this.fetch, this.pricingUrl);
   }
   ```
4. Delete `PRICING_TIMEOUT_MS`, `interface ModelPricing`, `parsePricing`, `priceKeyCandidates`, the local `priceForModel`, `readObject`, `readNumber`, `ROUTING_PREFIXES` and the local `export function stripRoutingPrefix`.
5. In the doc comment above `fetchPricing`, change `(see {@link priceKeyCandidates})` to `(see \`priceKeyCandidates\` in \`pricing.ts\`)`, since the function no longer lives in this file.
6. In `toCatalogModel`, change the parameter type `pricing: Map<string, ModelPricing>` to `pricing: Map<string, ModelPrice>`. The call `priceForModel(pricing, modelId)` stays as it is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/pricing.test.ts src/agents/catalog.test.ts && pnpm typecheck`
Expected: PASS for both files (the catalogue's price tests still pass unchanged), and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add server-ts/src/agents/pricing.ts server-ts/src/agents/pricing.test.ts server-ts/src/agents/catalog.ts
git commit -m "feat(server-ts): read model prices, cache tokens included, from one place"
```

---

### Task 2: `task_usage`, its hourly rollup, and `recordTaskUsage`

**Files:**
- Create: `server-ts/migrations/080_task_usage.up.sql`
- Create: `server-ts/src/usage/record.ts`
- Create: `server-ts/src/usage/test-fixtures.ts`
- Create: `server-ts/src/usage/record.test.ts`
- Modify: `server-ts/src/runs/ledger.ts:432-440` (the `UPDATE runs` in `completeSuccess`)
- Modify: `server-ts/src/realtime/replay.ts` (`WORKSPACE_TOPICS` gains `'usage.recorded'`)
- Modify: `server-ts/src/realtime/replay.test.ts` (one new test)

**Interfaces:**
- Consumes: `PricingSource`, `costMicrosFor`, `ModelPrice` from Task 1.
- Produces:
  - `recordTaskUsage(sql: Sql, input: TaskUsageInput): Promise<void>`, where `TaskUsageInput = { runId: string; workspaceId: string; agentId: string; runtimeId?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }`
  - `taskUsageInputSchema` (Zod v4), `type TaskUsageInput`
  - `configureUsagePricing(source: PricingSource | null): void`
  - `class UsageRunMismatch extends Error` (the run does not exist in that workspace, or `agentId` is not the run's agent). The run's workspace comes from its board, or after A from `runs.workspace_id` read via `to_jsonb(r)`. It is never taken from the report alone.
  - Tables `task_usage` and `task_usage_hourly` (constraint `task_usage_hourly_key`)
  - Fixtures: `interface UsageWorld { userId; workspaceId; boardId; agentId; agentName; issueId; runId }`, `seedUsageWorld(sql, label)`, `addRun(sql, world)`, `finishRun(sql, runId, status)`, `cleanupUsageWorld(sql, world)`, `scopeOf(sql, workspaceId): ScopedQuery`
  - Outbox topic `usage.recorded`

- [ ] **Step 1: Write the migration**

`server-ts/migrations/080_task_usage.up.sql`:

```sql
-- Berry migration 080 (workstream C, block 080-084): model usage per event and its hourly rollup.
--
-- task_usage is the record: one row per usage report from a run, priced when
-- written. task_usage_hourly is a projection maintained on the same write, so
-- a 90-day chart reads a few thousand rows rather than every model call.
-- runtime_id carries no foreign key on purpose: agent_runtimes belongs to
-- another migration block, and usage must be recordable before it exists.

CREATE TABLE IF NOT EXISTS task_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    agent_id uuid NOT NULL,
    runtime_id uuid,
    model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 300),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
    currency text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (cost_micros IS NULL AND currency IS NULL)
        OR (cost_micros IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    )
);

CREATE INDEX IF NOT EXISTS task_usage_workspace_time_idx
    ON task_usage (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_usage_run_idx
    ON task_usage (run_id);
CREATE INDEX IF NOT EXISTS task_usage_issue_idx
    ON task_usage (issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_usage_hourly (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bucket timestamptz NOT NULL,
    agent_id uuid NOT NULL,
    runtime_id uuid,
    model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 300),
    events integer NOT NULL DEFAULT 0 CHECK (events >= 0),
    unpriced_events integer NOT NULL DEFAULT 0
        CHECK (unpriced_events >= 0 AND unpriced_events <= events),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- NULLS NOT DISTINCT (PostgreSQL 15+; Compose runs 16): the workspace-default
    -- runtime is NULL, and its rows must fold into one bucket, not one per event.
    CONSTRAINT task_usage_hourly_key
        UNIQUE NULLS NOT DISTINCT (workspace_id, bucket, agent_id, runtime_id, model)
);

CREATE INDEX IF NOT EXISTS task_usage_hourly_workspace_bucket_idx
    ON task_usage_hourly (workspace_id, bucket);
CREATE INDEX IF NOT EXISTS task_usage_hourly_agent_idx
    ON task_usage_hourly (workspace_id, agent_id, bucket);
```

- [ ] **Step 2: Write the fixtures**

`server-ts/src/usage/test-fixtures.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import type { ScopedQuery } from '../identity/workspace-context.ts';

/**
 * A workspace with one member, one board, one agent, one task and one queued
 * run, for the usage tests. Not a test file, so the `*.test.ts` glob never
 * runs it on its own.
 */

export interface UsageWorld {
   userId: string;
   workspaceId: string;
   boardId: string;
   agentId: string;
   agentName: string;
   issueId: string;
   runId: string;
}

export async function seedUsageWorld(sql: Sql, label: string): Promise<UsageWorld> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`usage-${label}-${suffix}@berry.test`}, ${`Usage ${label}`})
      RETURNING id`;
   const userId = user!.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Usage ${label} ${suffix}`}, ${`usage-${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'USE', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Usage board', ${`use-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board!.id as string;
   const agentName = `Forge ${label}`;
   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, ${agentName}, 'Be brief.')
      RETURNING id`;
   const world: UsageWorld = {
      userId,
      workspaceId,
      boardId,
      agentId: agent!.id as string,
      agentName,
      issueId: '',
      runId: '',
   };
   const first = await addRun(sql, world);
   world.issueId = first.issueId;
   world.runId = first.runId;
   return world;
}

/** A new task with one queued run. One per task, because a task holds one active run. */
export async function addRun(
   sql: Sql,
   world: UsageWorld
): Promise<{ issueId: string; runId: string }> {
   const issueId = randomUUID();
   const runId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${world.boardId} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${world.boardId}, ${Number(counter!.issue_counter)},
                 'Usage task', 'todo', ${world.userId})`;
      await tx`
         INSERT INTO runs (id, issue_id, board_id, agent_id)
         VALUES (${runId}, ${issueId}, ${world.boardId}, ${world.agentId})`;
   });
   return { issueId, runId };
}

/** Moves a run to a state, satisfying the ledger's CHECKs on failure and completion. */
export async function finishRun(
   sql: Sql,
   runId: string,
   status: 'running' | 'succeeded' | 'failed' | 'cancelled'
): Promise<void> {
   if (status === 'running') {
      await sql`UPDATE runs SET status = 'running', started_at = now() WHERE id = ${runId}`;
      return;
   }
   await sql`
      UPDATE runs
         SET status = ${status}::run_status,
             started_at = COALESCE(started_at, now()),
             completed_at = now(),
             failure_code = ${status === 'failed' ? 'TEST_FAILURE' : null},
             failure_message = ${status === 'failed' ? 'failed in a test' : null}
       WHERE id = ${runId}`;
}

export async function cleanupUsageWorld(sql: Sql, world: UsageWorld | undefined): Promise<void> {
   if (!world?.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM task_usage_hourly WHERE workspace_id = ${world.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${world.workspaceId})`;
   // Protected agents refuse deletion by trigger, deliberately; suspended only
   // for the fixture's own teardown, as the run repository tests do.
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id = ${world.workspaceId}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${world.userId}`;
}

/** A scoped query surface for calling the read functions without a request. */
export function scopeOf(sql: Sql, workspaceId: string): ScopedQuery {
   return { sql, workspaceId, scope: sql`workspace_id = ${workspaceId}` };
}
```

- [ ] **Step 3: Write the failing tests**

`server-ts/src/usage/record.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ZodError } from 'zod';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunLedger } from '../runs/ledger.ts';
import type { ModelPrice, PricingSource } from '../agents/pricing.ts';
import { UsageRunMismatch, configureUsagePricing, recordTaskUsage } from './record.ts';
import { addRun, cleanupUsageWorld, seedUsageWorld, type UsageWorld } from './test-fixtures.ts';

/**
 * The one write path for model usage. A usage report is priced when written,
 * folded into its hour, added to its run's totals and announced on the
 * workspace stream, in one transaction, so no reader sees a cost the run
 * does not also show.
 */

const SONNET_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const pricing: PricingSource = {
   priceFor: async (model) => (model === SONNET_ID ? SONNET : null),
};

test('malformed usage is refused before the database is touched', async () => {
   const sql = {
      begin: () => {
         throw new Error('database touched');
      },
   } as unknown as Sql;
   await assert.rejects(
      recordTaskUsage(sql, {
         runId: 'not-a-uuid',
         workspaceId: '00000000-0000-4000-8000-000000000001',
         agentId: '00000000-0000-4000-8000-000000000002',
         model: SONNET_ID,
         inputTokens: -1,
         outputTokens: 0,
         cacheReadTokens: 0,
         cacheWriteTokens: 0,
      }),
      (error: unknown) => error instanceof ZodError
   );
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('recording task usage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: UsageWorld;
   let other: UsageWorld;

   before(async () => {
      sql = openDatabase({ url: url! });
      world = await seedUsageWorld(sql, 'rec');
      other = await seedUsageWorld(sql, 'rec-other');
   });

   after(async () => {
      configureUsagePricing(null);
      await cleanupUsageWorld(sql, world);
      await cleanupUsageWorld(sql, other);
      await closeDatabase(sql);
   });

   afterEach(() => configureUsagePricing(null));

   function report(runId: string, overrides: Partial<Parameters<typeof recordTaskUsage>[1]> = {}) {
      return {
         runId,
         workspaceId: world.workspaceId,
         agentId: world.agentId,
         model: SONNET_ID,
         inputTokens: 1000,
         outputTokens: 500,
         cacheReadTokens: 2000,
         cacheWriteTokens: 100,
         ...overrides,
      };
   }

   test('a usage report is priced on write and lands in its run totals', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));

      const [row] = await sql`
         SELECT cost_micros, currency, issue_id FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(Number(row!.cost_micros), 11475);
      assert.equal(row!.currency, 'USD');
      assert.ok(row!.issue_id, 'the task is copied from the run');

      const [run] = await sql`
         SELECT input_tokens, output_tokens, total_tokens, cost_micros, currency
           FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1000);
      assert.equal(Number(run!.output_tokens), 500);
      assert.equal(Number(run!.total_tokens), 1500);
      assert.equal(Number(run!.cost_micros), 11475);
      assert.equal(run!.currency, 'USD');
   });

   test('two reports in the same hour fold into one hourly row', async () => {
      // In `other`, whose hourly rows no other test writes, so the counts are exact.
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, other);
      const mine = { workspaceId: other.workspaceId, agentId: other.agentId };
      await recordTaskUsage(sql, report(runId, mine));
      await recordTaskUsage(
         sql,
         report(runId, { ...mine, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
      );

      const [hours] = await sql`
         SELECT COUNT(DISTINCT date_trunc('hour', occurred_at, 'UTC'))::int AS n
           FROM task_usage WHERE run_id = ${runId}`;
      const rows = await sql`
         SELECT events, unpriced_events, input_tokens, cost_micros FROM task_usage_hourly
          WHERE workspace_id = ${other.workspaceId} AND agent_id = ${other.agentId}
            AND model = ${SONNET_ID}`;
      // One row per hour touched: one, unless the two writes straddled an hour.
      assert.equal(rows.length, Number(hours!.n));
      assert.equal(rows.reduce((sum, row) => sum + Number(row.events), 0), 2);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.input_tokens), 0), 1010);
      assert.equal(rows.reduce((sum, row) => sum + Number(row.unpriced_events), 0), 0);
      const [run] = await sql`SELECT input_tokens, cost_micros FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1010);
      assert.equal(Number(run!.cost_micros), 11475 + 30);
   });

   test('a model without a published price is recorded with no cost, not a zero one', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId, { model: 'us.unknown.model-v1:0' }));

      const [row] = await sql`SELECT cost_micros, currency FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(row!.cost_micros, null);
      assert.equal(row!.currency, null);
      const [hour] = await sql`
         SELECT unpriced_events, cost_micros FROM task_usage_hourly
          WHERE workspace_id = ${world.workspaceId} AND model = 'us.unknown.model-v1:0'`;
      assert.equal(Number(hour!.unpriced_events), 1);
      assert.equal(Number(hour!.cost_micros), 0);
      const [run] = await sql`SELECT cost_micros, currency FROM runs WHERE id = ${runId}`;
      assert.equal(run!.cost_micros, null);
      assert.equal(run!.currency, null);
   });

   test('with no price source configured, usage is still recorded', async () => {
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      const [row] = await sql`SELECT input_tokens, cost_micros FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(Number(row!.input_tokens), 1000);
      assert.equal(row!.cost_micros, null);
   });

   test('usage naming a run from another workspace is refused and writes nothing', async () => {
      await assert.rejects(
         recordTaskUsage(sql, report(other.runId)),
         (error: unknown) => error instanceof UsageRunMismatch
      );
      const rows = await sql`SELECT 1 FROM task_usage WHERE run_id = ${other.runId}`;
      assert.equal(rows.length, 0);
   });

   test("usage naming another tenant's agent on this workspace's run is refused", async () => {
      const { runId } = await addRun(sql, world);
      await assert.rejects(
         recordTaskUsage(sql, report(runId, { agentId: other.agentId })),
         (error: unknown) => error instanceof UsageRunMismatch
      );
      const rows = await sql`SELECT 1 FROM task_usage WHERE run_id = ${runId}`;
      assert.equal(rows.length, 0);
   });

   test('a later success write does not erase usage already recorded', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      await new RunLedger({ sql }).completeSuccess({
         runId,
         summary: 'done',
         usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null },
      });
      const [run] = await sql`SELECT input_tokens, cost_micros, currency FROM runs WHERE id = ${runId}`;
      assert.equal(Number(run!.input_tokens), 1000);
      assert.equal(Number(run!.cost_micros), 11475);
      assert.equal(run!.currency, 'USD');
   });

   test('each report is announced on the workspace stream', async () => {
      configureUsagePricing(pricing);
      const { runId } = await addRun(sql, world);
      await recordTaskUsage(sql, report(runId));
      const events = await sql`
         SELECT topic, aggregate_type, payload FROM outbox_events
          WHERE workspace_id = ${world.workspaceId} AND aggregate_id = ${runId}`;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.topic, 'usage.recorded');
      assert.equal(events[0]!.aggregate_type, 'run');
      const envelope = events[0]!.payload as { boardId: unknown; payload: { costMicros: unknown } };
      assert.equal(envelope.boardId, null);
      assert.equal(envelope.payload.costMicros, 11475);
   });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/usage/record.test.ts`
Expected: FAIL, `Cannot find module … record.ts`.

- [ ] **Step 5: Write the implementation**

`server-ts/src/usage/record.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { costMicrosFor, type PricingSource } from '../agents/pricing.ts';

/**
 * Model usage, recorded as it is reported.
 *
 * One row per report (a `task.usage` lifecycle event, or one in-process run),
 * priced on write from the same feed the model picker shows. The hourly
 * rollup, the run's totals and a workspace-stream event are written in the
 * same transaction, so the Usage page, the run and the dashboard can never
 * disagree about what was spent.
 */

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const taskUsageInputSchema = z.object({
   runId: z.uuid(),
   workspaceId: z.uuid(),
   agentId: z.uuid(),
   runtimeId: z.uuid().optional(),
   model: z.string().min(1).max(300),
   inputTokens: tokens,
   outputTokens: tokens,
   cacheReadTokens: tokens,
   cacheWriteTokens: tokens,
});

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

/**
 * The run is absent, belongs to a different workspace than the report claims,
 * or was not run by the reported agent.
 */
export class UsageRunMismatch extends Error {
   constructor(runId: string) {
      super(`run ${runId} is not in the reporting workspace`);
      this.name = 'UsageRunMismatch';
   }
}

let pricing: PricingSource | null = null;

/**
 * Where costs come from. Set once by the composition root. Null means usage
 * is recorded unpriced, which a reader shows as "no price" rather than as free.
 */
export function configureUsagePricing(source: PricingSource | null): void {
   pricing = source;
}

async function priceOf(model: string, counts: TaskUsageInput): Promise<number | null> {
   if (!pricing) return null;
   try {
      const price = await pricing.priceFor(model);
      return price ? costMicrosFor(price, counts) : null;
   } catch {
      // A price lookup is never a reason to lose the usage itself.
      return null;
   }
}

export async function recordTaskUsage(sql: Sql, input: TaskUsageInput): Promise<void> {
   const usage = taskUsageInputSchema.parse(input);
   const costMicros = await priceOf(usage.model, usage);
   const currency = costMicros === null ? null : 'USD';
   const runtimeId = usage.runtimeId ?? null;
   const id = randomUUID();

   await sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;

      // The run's workspace is re-derived rather than trusted: a report naming
      // a run in another workspace would otherwise bill that workspace's chart.
      // Today every run has a board. Workstream A makes runs.board_id nullable
      // (completion tasks) and adds runs.workspace_id; that column is read
      // through to_jsonb(r) so this SQL parses before A's migration and after
      // it. A run whose workspace cannot be derived at all is refused, never
      // accepted on the reporter's word. The agent must be the run's own
      // agent, so a report cannot attribute spend to another tenant's agent.
      const [row] = await tx`
         INSERT INTO task_usage (
            id, workspace_id, run_id, issue_id, agent_id, runtime_id, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_micros, currency
         )
         SELECT ${id}, ${usage.workspaceId}, r.id, r.issue_id, ${usage.agentId}, ${runtimeId},
                ${usage.model}, ${usage.inputTokens}, ${usage.outputTokens},
                ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, ${costMicros}, ${currency}
           FROM runs AS r
           LEFT JOIN boards AS b ON b.id = r.board_id
          WHERE r.id = ${usage.runId}
            AND r.agent_id = ${usage.agentId}
            AND COALESCE(b.workspace_id, (to_jsonb(r) ->> 'workspace_id')::uuid)
                = ${usage.workspaceId}::uuid
         RETURNING occurred_at, issue_id`;
      if (!row) throw new UsageRunMismatch(usage.runId);
      const occurredAt = row.occurred_at as string;
      const issueId = (row.issue_id as string | null) ?? null;

      await tx`
         INSERT INTO task_usage_hourly (
            workspace_id, bucket, agent_id, runtime_id, model, events, unpriced_events,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros
         ) VALUES (
            ${usage.workspaceId}, date_trunc('hour', ${occurredAt}::timestamptz, 'UTC'),
            ${usage.agentId}, ${runtimeId}, ${usage.model}, 1, ${costMicros === null ? 1 : 0},
            ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens},
            ${usage.cacheWriteTokens}, ${costMicros ?? 0}
         )
         ON CONFLICT ON CONSTRAINT task_usage_hourly_key DO UPDATE SET
            events = task_usage_hourly.events + 1,
            unpriced_events = task_usage_hourly.unpriced_events + EXCLUDED.unpriced_events,
            input_tokens = task_usage_hourly.input_tokens + EXCLUDED.input_tokens,
            output_tokens = task_usage_hourly.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = task_usage_hourly.cache_read_tokens + EXCLUDED.cache_read_tokens,
            cache_write_tokens = task_usage_hourly.cache_write_tokens + EXCLUDED.cache_write_tokens,
            cost_micros = task_usage_hourly.cost_micros + EXCLUDED.cost_micros,
            updated_at = now()`;

      // Recomputed from the record rather than incremented, so a retried or
      // reordered write cannot drift the run away from its own rows. A run with
      // no priced report keeps a NULL cost: unknown, not free.
      await tx`
         UPDATE runs AS r
            SET input_tokens = t.input_tokens,
                output_tokens = t.output_tokens,
                total_tokens = t.input_tokens + t.output_tokens,
                cost_micros = t.cost_micros,
                currency = CASE WHEN t.cost_micros IS NULL THEN NULL ELSE 'USD' END
           FROM (
              SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                     COALESCE(SUM(output_tokens), 0) AS output_tokens,
                     SUM(cost_micros) AS cost_micros
                FROM task_usage WHERE run_id = ${usage.runId}
           ) AS t
          WHERE r.id = ${usage.runId}`;

      const eventId = randomUUID();
      const payload = {
         runId: usage.runId,
         issueId,
         agentId: usage.agentId,
         runtimeId,
         model: usage.model,
         inputTokens: usage.inputTokens,
         outputTokens: usage.outputTokens,
         cacheReadTokens: usage.cacheReadTokens,
         cacheWriteTokens: usage.cacheWriteTokens,
         costMicros,
      };
      const envelope = {
         id: eventId,
         type: 'usage.recorded',
         occurredAt: toRFC3339(occurredAt),
         workspaceId: usage.workspaceId,
         // Workspace-level, like goals: usage belongs to no board's replay.
         boardId: null,
         aggregateType: 'run',
         aggregateId: usage.runId,
         payload,
      };
      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${eventId}, 'usage.recorded', 'run', ${usage.runId}, ${usage.workspaceId}, NULL,
            ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
         )`;
   });
}
```

Then, in `server-ts/src/runs/ledger.ts`, inside `completeSuccess`, replace these five lines of the `UPDATE runs`:

```ts
                   input_tokens = ${params.usage.inputTokens},
                   output_tokens = ${params.usage.outputTokens},
                   total_tokens = ${params.usage.totalTokens},
                   cost_micros = ${params.usage.costMicros},
                   currency = ${params.usage.currency},
```

with:

```ts
                   -- Usage recorded while the run worked (task_usage) is never
                   -- lowered or unpriced by the completion write that follows it.
                   input_tokens = GREATEST(input_tokens, ${params.usage.inputTokens}),
                   output_tokens = GREATEST(output_tokens, ${params.usage.outputTokens}),
                   total_tokens = GREATEST(total_tokens, ${params.usage.totalTokens}),
                   cost_micros = COALESCE(${params.usage.costMicros}, cost_micros),
                   currency = COALESCE(${params.usage.currency}, currency),
```

(`costMicros` and `currency` are both null or both set, so the COALESCE pair keeps the run's both-or-neither CHECK.)

Then register the topic on the workspace stream. `server-ts/src/mounts/events.ts` replays and polls `outbox_events` with `topic = ANY(WORKSPACE_TOPICS)`, so without this `usage.recorded` is written but never delivered, and `useUsage` (Task 6) never refreshes. In `server-ts/src/realtime/replay.ts`, append to `WORKSPACE_TOPICS`, after `'artifact.created',`:

```ts
   // Workspace-level like goals (boardId null): the Usage page, the Dashboard
   // and the usage panels refresh on it.
   'usage.recorded',
```

And append to `server-ts/src/realtime/replay.test.ts`:

```ts
test('recorded usage reaches the workspace stream, not the board stream', () => {
   assert.ok((WORKSPACE_TOPICS as readonly string[]).includes('usage.recorded'));
   assert.ok(!(BOARD_TOPICS as readonly string[]).includes('usage.recorded'));
});
```

(Run it before editing `replay.ts` to see it fail: `node --test --experimental-strip-types src/realtime/replay.test.ts`.)

- [ ] **Step 6: Apply the migration to the test database and run the tests**

Run:
```bash
cd /Users/secret/Code/berry-circle/server-ts
node --test --experimental-strip-types src/usage/record.test.ts
DATABASE_URL="$BERRY_TEST_DATABASE_URL" pnpm migrate && \
  node --test --experimental-strip-types src/usage/record.test.ts src/runs/ledger.test.ts \
    src/realtime/replay.test.ts src/mounts/events.test.ts
```
Expected: the first command passes the offline test and skips the DB suite. With `BERRY_TEST_DATABASE_URL` set (see `server-ts/ROUTING.md`, "Running the database-backed tests"), all record tests pass and `ledger.test.ts` still passes.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/secret/Code/berry-circle && pnpm typecheck:server
git add server-ts/migrations/080_task_usage.up.sql server-ts/src/usage/record.ts \
  server-ts/src/usage/record.test.ts server-ts/src/usage/test-fixtures.ts server-ts/src/runs/ledger.ts \
  server-ts/src/realtime/replay.ts server-ts/src/realtime/replay.test.ts
git commit -m "feat(server-ts): record task usage priced on write, with an hourly rollup"
```

---

### Task 3: In-process runs record their usage (until workstream A takes over)

**Files:**
- Modify: `server-ts/src/agents/runtime/scripted-model.ts:31-35` (`interface Usage`)
- Modify: `server-ts/src/agents/runtime/plugins/accounting.ts`
- Modify: `server-ts/src/agents/runtime/plugins/accounting.test.ts`
- Create: `server-ts/src/usage/in-process.ts`
- Create: `server-ts/src/usage/in-process.test.ts`
- Modify: `server-ts/src/agents/executor.ts` (options, constructor, `run()` return points)
- Modify: `server-ts/src/index.ts` (pricing configuration, the executor's `onUsageError`)

**Interfaces:**
- Consumes: `recordTaskUsage`, `TaskUsageInput`, `configureUsagePricing` (Task 2), and `PriceBook` (Task 1).
- Produces:
  - `AccountingSnapshot` gains `cacheReadTokens: number; cacheWriteTokens: number`
  - `usageRecordFor(run: { runId: string; workspaceId: string; agentId: string; model: string }, snapshot: Pick<AccountingSnapshot, 'usage' | 'modelCalls' | 'cacheReadTokens' | 'cacheWriteTokens'>): TaskUsageInput | null`
  - `ExecutorOptions.recordUsage?: ((sql: Sql, input: TaskUsageInput) => Promise<void>) | null` (default `recordTaskUsage`, `null` disables it) and `ExecutorOptions.onUsageError?: (error: unknown) => void`
- Note for workstream A: once the loop moves into the container, delete the executor call added here and call `recordTaskUsage` on every `task.usage` event instead. `usageRecordFor` is the mapping to reuse.

- [ ] **Step 1: Write the failing tests**

Append to `server-ts/src/agents/runtime/plugins/accounting.test.ts`:

```ts
test('cache reads and writes are counted apart from input', async () => {
   const model = new ScriptedModel([
      call('echo', { text: 'a' }, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheWriteInputTokens: 50 }),
      say('done', { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 1000 }),
   ]);
   const accounting = new AccountingPlugin();
   const agent = new Agent({ model, tools: [echo], plugins: [accounting], printer: false });
   await agent.invoke('go');
   const snapshot = accounting.snapshot();
   assert.equal(snapshot.usage.inputTokens, 120);
   assert.equal(snapshot.cacheReadTokens, 1900);
   assert.equal(snapshot.cacheWriteTokens, 50);
});
```

`server-ts/src/usage/in-process.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageRecordFor } from './in-process.ts';

const RUN = {
   runId: '00000000-0000-4000-8000-000000000001',
   workspaceId: '00000000-0000-4000-8000-000000000002',
   agentId: '00000000-0000-4000-8000-000000000003',
   model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
};

function snapshot(input: number, output: number, cacheRead = 0, cacheWrite = 0, modelCalls = 1) {
   return {
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, costMicros: null, currency: null },
      modelCalls,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
   };
}

test('a run that never called the model records nothing', () => {
   assert.equal(usageRecordFor(RUN, snapshot(0, 0, 0, 0, 0)), null);
});

test('a run that called the model records every token kind against its agent and model', () => {
   assert.deepEqual(usageRecordFor(RUN, snapshot(120, 15, 1900, 50)), {
      ...RUN,
      inputTokens: 120,
      outputTokens: 15,
      cacheReadTokens: 1900,
      cacheWriteTokens: 50,
   });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/runtime/plugins/accounting.test.ts src/usage/in-process.test.ts`
Expected: FAIL. The accounting test fails to typecheck or run on `cacheReadInputTokens`, or asserts `undefined !== 1900`. `in-process.ts` is not found.

- [ ] **Step 3: Write the implementation**

In `server-ts/src/agents/runtime/scripted-model.ts`, replace the body of `interface Usage` (lines 31–34) so it reads:

```ts
interface Usage {
   inputTokens: number;
   outputTokens: number;
   /** Named as the SDK names them, so the metadata event carries them as-is. */
   cacheReadInputTokens?: number;
   cacheWriteInputTokens?: number;
}
```

(Line 113 already spreads `usage` into the metadata event, so nothing else changes.)

In `server-ts/src/agents/runtime/plugins/accounting.ts`:

```ts
export interface AccountingSnapshot {
   usage: Usage;
   /** Prompt-cache tokens. Kept beside `usage` because the ledger's Usage has no place for them. */
   cacheReadTokens: number;
   cacheWriteTokens: number;
   toolCalls: number;
   modelCalls: number;
   result: ResultText;
}
```

Add fields to the class after `#modelCalls = 0;`:

```ts
   #cacheReadTokens = 0;
   #cacheWriteTokens = 0;
```

In the `ModelStreamUpdateEvent` hook, after the `totalTokens` line, add:

```ts
            this.#cacheReadTokens += inner.usage.cacheReadInputTokens ?? 0;
            this.#cacheWriteTokens += inner.usage.cacheWriteInputTokens ?? 0;
```

In `snapshot()`, add `cacheReadTokens: this.#cacheReadTokens, cacheWriteTokens: this.#cacheWriteTokens,` after the `usage` line.

`server-ts/src/usage/in-process.ts`:

```ts
import type { AccountingSnapshot } from '../agents/runtime/plugins/accounting.ts';
import type { TaskUsageInput } from './record.ts';

/**
 * One in-process run's usage as a single usage report.
 *
 * The in-process loop reports once, at the end, because the accounting plugin
 * already sums every model call. The runtime path (workstream A) reports per
 * `task.usage` event instead. Both land in the same table.
 */
export function usageRecordFor(
   run: { runId: string; workspaceId: string; agentId: string; model: string },
   snapshot: Pick<AccountingSnapshot, 'usage' | 'modelCalls' | 'cacheReadTokens' | 'cacheWriteTokens'>
): TaskUsageInput | null {
   const { inputTokens, outputTokens } = snapshot.usage;
   const spent = inputTokens + outputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens;
   if (snapshot.modelCalls === 0 && spent === 0) return null;
   return {
      runId: run.runId,
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      model: run.model,
      inputTokens,
      outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
   };
}
```

In `server-ts/src/agents/executor.ts`:

1. Add imports:
   ```ts
   import { recordTaskUsage, type TaskUsageInput } from '../usage/record.ts';
   import { usageRecordFor } from '../usage/in-process.ts';
   import type { AccountingSnapshot } from './runtime/plugins/accounting.ts';
   ```
   (If `AccountingPlugin` is already imported from that module, add `type AccountingSnapshot` to that import instead.)
2. In `ExecutorOptions`, directly after `onGateError?: (error: unknown) => void;`, add:
   ```ts
   /**
    * Records a finished run's model usage. Defaults to `recordTaskUsage`;
    * `null` turns it off. A failure is reported through `onUsageError` and
    * never changes how the run ended.
    */
   recordUsage?: ((sql: Sql, input: TaskUsageInput) => Promise<void>) | null;
   onUsageError?: (error: unknown) => void;
   ```
3. Add private fields beside `private readonly defaultModel: string;`:
   ```ts
   private readonly recordUsageFn: ((sql: Sql, input: TaskUsageInput) => Promise<void>) | null;
   private readonly onUsageError: (error: unknown) => void;
   ```
   and in the constructor, beside `this.defaultModel = …`:
   ```ts
   this.recordUsageFn = options.recordUsage === undefined ? recordTaskUsage : options.recordUsage;
   this.onUsageError = options.onUsageError ?? (() => undefined);
   ```
4. Add a private method next to `loadAgent`:
   ```ts
   /** After the terminal write, so the run's own totals are recomputed last. */
   private async recordUsage(
      dispatch: Dispatch,
      model: string,
      snapshot: AccountingSnapshot
   ): Promise<void> {
      if (!this.recordUsageFn) return;
      const input = usageRecordFor(
         { runId: dispatch.runId, workspaceId: dispatch.workspaceId, agentId: dispatch.agentId, model },
         snapshot
      );
      if (!input) return;
      try {
         await this.recordUsageFn(this.sql, input);
      } catch (error) {
         this.onUsageError(error);
      }
   }
   ```
5. In `run(dispatch, agent, signal)`, replace the `catch (error) { … }` body's snapshot and returns:
   ```ts
            await ledger.flush().catch(() => undefined);
            const snapshot = accounting.snapshot();
            const { usage, toolCalls } = snapshot;
            if (error instanceof RunCancelled || signal?.aborted) {
               const outcome = await this.cancel(dispatch, usage, toolCalls);
               await this.recordUsage(dispatch, agent.model, snapshot);
               return outcome;
            }
            const outcome = await this.fail(dispatch, error, usage, toolCalls);
            await this.recordUsage(dispatch, agent.model, snapshot);
            return outcome;
   ```
   Keep the existing comments in place. Replace the success return that follows the catch:
   ```ts
         const snapshot = accounting.snapshot();
         const outcome = await this.succeed(dispatch, snapshot.result, snapshot.usage, snapshot.toolCalls);
         await this.recordUsage(dispatch, agent.model, snapshot);
         return outcome;
   ```

In `server-ts/src/index.ts`:

1. Add imports:
   ```ts
   import { PriceBook } from './agents/pricing.ts';
   import { configureUsagePricing } from './usage/record.ts';
   ```
2. Directly after the `const modelCatalog = …;` statement, add:
   ```ts
   // Usage is priced on write from the same open feed the model picker reads.
   // Not gated on agent config: runs executed elsewhere still report usage here.
   configureUsagePricing(new PriceBook());
   ```
3. In the `const executor = … new RunExecutor({ … })` options (not the `ReviewGate` above it, which also has a `defaultModel: config.agents.defaultModel,` line), directly after the closing `}),` of the existing `onGateError: (error) => …` entry, add:
   ```ts
           onUsageError: (error: unknown) =>
              logger.error('usage record failed', {
                 error: error instanceof Error ? error.message : String(error),
              }),
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle && pnpm typecheck:server && cd server-ts && node --test --experimental-strip-types src/agents/runtime/plugins/accounting.test.ts src/usage/in-process.test.ts src/agents/executor-loop.test.ts src/llm/credential-plumbing.test.ts`
Expected: PASS. `tsc` exits 0. The existing executor suites still pass (DB-gated ones skip offline).

- [ ] **Step 5: Run the whole server suite, then commit**

Run: `cd /Users/secret/Code/berry-circle && pnpm test:server`
Expected: PASS.

```bash
git add server-ts/src/agents/runtime/scripted-model.ts server-ts/src/agents/runtime/plugins/accounting.ts \
  server-ts/src/agents/runtime/plugins/accounting.test.ts server-ts/src/usage/in-process.ts \
  server-ts/src/usage/in-process.test.ts server-ts/src/agents/executor.ts server-ts/src/index.ts
git commit -m "feat(server-ts): record each in-process run's usage, cache tokens included"
```

---

### Task 4: Usage and dashboard reads

**Files:**
- Create: `server-ts/src/usage/queries.ts`
- Create: `server-ts/src/usage/queries.test.ts`

**Interfaces:**
- Consumes: the tables (Task 2), `ScopedQuery` from `server-ts/src/identity/workspace-context.ts`, `issueStatusToApi` from `server-ts/src/runs/ledger.ts`, and the fixtures from Task 2.
- Produces (every function reads only rows where `workspace_id = q.workspaceId`):
  - `interface UsageWindow { days: number; from: string; to: string }`, `usageWindow(days: number, now?: Date): UsageWindow`
  - `interface UsageBucket { key; events; unpricedEvents; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costMicros }`, `interface AgentUsageBucket extends UsageBucket { agentName: string }`
  - `workspaceUsage(q, window): Promise<{ totals; daily; byAgent; byModel }>`
  - `agentUsage(q, agentId, window): Promise<{ totals; daily; byModel }>`
  - `runtimeUsage(q, runtimeId: string | null, window): Promise<{ totals; daily; byAgent; byHour }>`
  - `runtimeVisible(q, runtimeId: string): Promise<boolean>`
  - `issueInWorkspace(q, issueId): Promise<boolean>`, `issueUsage(q, issueId): Promise<{ totals; byRun; byModel }>`
  - `dashboardOverview(q, window): Promise<DashboardOverview>` (shape as in the Wire contract, minus `currency/days/from/to`)

- [ ] **Step 1: Write the failing tests**

`server-ts/src/usage/queries.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { recordTaskUsage } from './record.ts';
import {
   agentUsage,
   dashboardOverview,
   issueInWorkspace,
   issueUsage,
   runtimeUsage,
   runtimeVisible,
   usageWindow,
   workspaceUsage,
} from './queries.ts';
import {
   addRun,
   cleanupUsageWorld,
   finishRun,
   scopeOf,
   seedUsageWorld,
   type UsageWorld,
} from './test-fixtures.ts';

test('a window starts at UTC midnight days-1 back and ends now', () => {
   const now = new Date('2026-09-10T15:30:00.000Z');
   assert.deepEqual(usageWindow(7, now), {
      days: 7,
      from: '2026-09-04T00:00:00.000Z',
      to: '2026-09-10T15:30:00.000Z',
   });
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('usage reads', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: UsageWorld;
   let other: UsageWorld;
   const RUNTIME = randomUUID();

   function usage(w: UsageWorld, runId: string, extra: { runtimeId?: string; model?: string } = {}) {
      return recordTaskUsage(sql, {
         runId,
         workspaceId: w.workspaceId,
         agentId: w.agentId,
         model: extra.model ?? 'model-a',
         inputTokens: 100,
         outputTokens: 10,
         cacheReadTokens: 5,
         cacheWriteTokens: 1,
         ...(extra.runtimeId ? { runtimeId: extra.runtimeId } : {}),
      });
   }

   before(async () => {
      sql = openDatabase({ url: url! });
      world = await seedUsageWorld(sql, 'q');
      other = await seedUsageWorld(sql, 'q-other');
      await usage(world, world.runId);
      await usage(world, world.runId, { model: 'model-b', runtimeId: RUNTIME });
      await usage(other, other.runId);
      await usage(other, other.runId);
      await usage(other, other.runId);
   });

   after(async () => {
      await cleanupUsageWorld(sql, world);
      await cleanupUsageWorld(sql, other);
      await closeDatabase(sql);
   });

   test('workspace usage sums only its own rows and zero-fills every day', async () => {
      const result = await workspaceUsage(scopeOf(sql, world.workspaceId), usageWindow(7));
      assert.equal(result.totals.events, 2);
      assert.equal(result.totals.inputTokens, 200);
      assert.equal(result.totals.cacheReadTokens, 10);
      assert.equal(result.totals.unpricedEvents, 2);
      assert.equal(result.daily.length, 7);
      assert.equal(result.daily.at(-1)?.inputTokens, 200);
      assert.equal(result.daily[0]?.inputTokens, 0);
      assert.deepEqual(result.byAgent.map((row) => [row.key, row.agentName]), [
         [world.agentId, world.agentName],
      ]);
      assert.deepEqual(result.byModel.map((row) => row.key).sort(), ['model-a', 'model-b']);
   });

   test('agent usage of a foreign agent is empty from this workspace', async () => {
      const result = await agentUsage(scopeOf(sql, world.workspaceId), other.agentId, usageWindow(7));
      assert.equal(result.totals.events, 0);
   });

   test('runtime usage separates the default runtime from a named one, by hour', async () => {
      const q = scopeOf(sql, world.workspaceId);
      const named = await runtimeUsage(q, RUNTIME, usageWindow(7));
      const fallback = await runtimeUsage(q, null, usageWindow(7));
      assert.equal(named.totals.events, 1);
      assert.equal(fallback.totals.events, 1);
      assert.equal(named.byHour.length, 24);
      assert.equal(named.byHour[0]?.key, '00');
      assert.equal(named.byHour.reduce((sum, row) => sum + row.events, 0), 1);
   });

   test('a runtime id is not visible when no runtime table or row names it', async () => {
      assert.equal(await runtimeVisible(scopeOf(sql, world.workspaceId), randomUUID()), false);
   });

   test('issue usage lists each run and refuses a task from another workspace', async () => {
      const q = scopeOf(sql, world.workspaceId);
      assert.equal(await issueInWorkspace(q, world.issueId), true);
      assert.equal(await issueInWorkspace(q, other.issueId), false);
      const result = await issueUsage(q, world.issueId);
      assert.equal(result.totals.events, 2);
      assert.deepEqual(result.byRun.map((row) => row.key), [world.runId]);
   });

   test('the dashboard counts runs by status and lists who is working now', async () => {
      const failed = await addRun(sql, world);
      await finishRun(sql, failed.runId, 'failed');
      const running = await addRun(sql, world);
      await finishRun(sql, running.runId, 'running');

      const result = await dashboardOverview(scopeOf(sql, world.workspaceId), usageWindow(30));
      assert.equal(result.runCounts.failed, 1);
      assert.equal(result.runCounts.running, 1);
      assert.equal(result.runCounts.queued, 1);
      assert.equal(result.runsDaily.length, 30);
      assert.equal(result.runsDaily.at(-1)?.failed, 1);
      assert.deepEqual(result.failuresByAgent.map((row) => [row.agentId, row.failed]), [
         [world.agentId, 1],
      ]);
      assert.deepEqual(result.workingAgents.map((row) => row.runId), [running.runId]);
      assert.equal(result.taskSnapshot.todo, 3);
      assert.equal(result.taskSnapshot.inProgress, 0);
      assert.equal(result.usageDaily.at(-1)?.events, 2);
   });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/usage/queries.test.ts`
Expected: FAIL, `Cannot find module … queries.ts`.

- [ ] **Step 3: Write the implementation**

`server-ts/src/usage/queries.ts`:

```ts
import type { ScopedQuery } from '../identity/workspace-context.ts';
import { issueStatusToApi } from '../runs/ledger.ts';

/**
 * Every read behind the Usage page, the Dashboard and the usage panels.
 *
 * Each takes a {@link ScopedQuery}, and each predicate is on
 * `q.workspaceId` — the membership-confirmed scope, never a request value —
 * so a foreign id finds nothing rather than someone else's spend. Charts read
 * the hourly rollup; a task's own panel reads the raw rows, because it wants
 * each run and there are few.
 */

export interface UsageWindow {
   days: number;
   from: string;
   to: string;
}

/** Whole UTC days: today plus the `days - 1` before it. */
export function usageWindow(days: number, now: Date = new Date()): UsageWindow {
   const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))
   );
   return { days, from: start.toISOString(), to: now.toISOString() };
}

export interface UsageBucket {
   key: string;
   events: number;
   /** Reports with no published price; their tokens count, their cost does not. */
   unpricedEvents: number;
   inputTokens: number;
   outputTokens: number;
   cacheReadTokens: number;
   cacheWriteTokens: number;
   costMicros: number;
}

export interface AgentUsageBucket extends UsageBucket {
   agentName: string;
}

type Row = Record<string, unknown>;

function toBucket(row: Row | undefined, fallbackKey = 'total'): UsageBucket {
   return {
      key: row?.key === undefined || row.key === null ? fallbackKey : String(row.key),
      events: Number(row?.events ?? 0),
      unpricedEvents: Number(row?.unpriced_events ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
      costMicros: Number(row?.cost_micros ?? 0),
   };
}

function toAgentBucket(row: Row): AgentUsageBucket {
   return { ...toBucket(row), agentName: String(row.agent_name) };
}

/** What narrows the hourly rollup beyond the workspace. */
interface HourlyFilter {
   agentId?: string;
   /** `{ id: null }` is the workspace-default runtime. Absent means every runtime. */
   runtime?: { id: string | null };
}

function hourlySums(q: ScopedQuery) {
   return q.sql`
      COALESCE(SUM(h.events), 0)::bigint AS events,
      COALESCE(SUM(h.unpriced_events), 0)::bigint AS unpriced_events,
      COALESCE(SUM(h.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(h.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(h.cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(h.cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COALESCE(SUM(h.cost_micros), 0)::bigint AS cost_micros`;
}

function hourlyFilter(q: ScopedQuery, filter: HourlyFilter) {
   const agent = filter.agentId ? q.sql`AND h.agent_id = ${filter.agentId}` : q.sql``;
   const runtime =
      filter.runtime === undefined
         ? q.sql``
         : filter.runtime.id === null
           ? q.sql`AND h.runtime_id IS NULL`
           : q.sql`AND h.runtime_id = ${filter.runtime.id}`;
   return q.sql`${agent} ${runtime}`;
}

async function hourlyTotals(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const [row] = await q.sql`
      SELECT 'total' AS key, ${hourlySums(q)}
        FROM task_usage_hourly AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}`;
   return toBucket(row);
}

async function hourlyDaily(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS key, ${hourlySums(q)}
        FROM generate_series(${window.from}::timestamptz, ${window.to}::timestamptz,
                             interval '1 day') AS d(day)
        LEFT JOIN task_usage_hourly AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= d.day AND h.bucket < d.day + interval '1 day'
             ${hourlyFilter(q, filter)}
       GROUP BY d.day
       ORDER BY d.day`;
   return rows.map((row) => toBucket(row));
}

async function hourlyByAgent(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT h.agent_id::text AS key, COALESCE(a.name, 'Removed agent') AS agent_name,
             ${hourlySums(q)}
        FROM task_usage_hourly AS h
        LEFT JOIN agents AS a ON a.id = h.agent_id AND a.workspace_id = ${q.workspaceId}
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}
       GROUP BY h.agent_id, a.name
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map(toAgentBucket);
}

async function hourlyByModel(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT h.model AS key, ${hourlySums(q)}
        FROM task_usage_hourly AS h
       WHERE h.workspace_id = ${q.workspaceId} AND h.bucket >= ${window.from}
             ${hourlyFilter(q, filter)}
       GROUP BY h.model
       ORDER BY cost_micros DESC, input_tokens DESC
       LIMIT 50`;
   return rows.map((row) => toBucket(row));
}

async function hourlyByHour(q: ScopedQuery, window: UsageWindow, filter: HourlyFilter) {
   const rows = await q.sql`
      SELECT to_char(g.hour, 'FM00') AS key, ${hourlySums(q)}
        FROM generate_series(0, 23) AS g(hour)
        LEFT JOIN task_usage_hourly AS h
          ON h.workspace_id = ${q.workspaceId}
         AND h.bucket >= ${window.from}
         AND EXTRACT(HOUR FROM h.bucket AT TIME ZONE 'UTC') = g.hour
             ${hourlyFilter(q, filter)}
       GROUP BY g.hour
       ORDER BY g.hour`;
   return rows.map((row) => toBucket(row));
}

export async function workspaceUsage(q: ScopedQuery, window: UsageWindow) {
   const filter: HourlyFilter = {};
   const [totals, daily, byAgent, byModel] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByAgent(q, window, filter),
      hourlyByModel(q, window, filter),
   ]);
   return { totals, daily, byAgent, byModel };
}

export async function agentUsage(q: ScopedQuery, agentId: string, window: UsageWindow) {
   const filter: HourlyFilter = { agentId };
   const [totals, daily, byModel] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByModel(q, window, filter),
   ]);
   return { totals, daily, byModel };
}

export async function runtimeUsage(q: ScopedQuery, runtimeId: string | null, window: UsageWindow) {
   const filter: HourlyFilter = { runtime: { id: runtimeId } };
   const [totals, daily, byAgent, byHour] = await Promise.all([
      hourlyTotals(q, window, filter),
      hourlyDaily(q, window, filter),
      hourlyByAgent(q, window, filter),
      hourlyByHour(q, window, filter),
   ]);
   return { totals, daily, byAgent, byHour };
}

/**
 * Whether a runtime id may be read from this workspace.
 *
 * `agent_runtimes` is workstream A's table and may not exist yet. Until it
 * does, only the workspace default (`'default'`, handled by the mount) is a
 * runtime. A platform runtime (no workspace) is visible to every workspace;
 * its usage is still filtered to this one.
 */
export async function runtimeVisible(q: ScopedQuery, runtimeId: string): Promise<boolean> {
   const [registry] = await q.sql`
      SELECT to_regclass('public.agent_runtimes') IS NOT NULL AS present`;
   if (!registry?.present) return false;
   const rows = await q.sql`
      SELECT 1 FROM agent_runtimes
       WHERE id = ${runtimeId}
         AND (workspace_id = ${q.workspaceId} OR workspace_id IS NULL)`;
   return rows.length > 0;
}

export async function issueInWorkspace(q: ScopedQuery, issueId: string): Promise<boolean> {
   const rows = await q.sql`
      SELECT 1 FROM issues AS i
        JOIN boards AS b ON b.id = i.board_id
       WHERE i.id = ${issueId} AND b.workspace_id = ${q.workspaceId} AND i.deleted_at IS NULL`;
   return rows.length > 0;
}

function rawSums(q: ScopedQuery) {
   return q.sql`
      COUNT(u.id)::bigint AS events,
      COUNT(u.id) FILTER (WHERE u.cost_micros IS NULL)::bigint AS unpriced_events,
      COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(u.cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COALESCE(SUM(u.cost_micros), 0)::bigint AS cost_micros`;
}

export async function issueUsage(q: ScopedQuery, issueId: string) {
   const [totalsRow] = await q.sql`
      SELECT 'total' AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}`;
   const byRun = await q.sql`
      SELECT u.run_id::text AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}
       GROUP BY u.run_id
       ORDER BY MIN(u.occurred_at)`;
   const byModel = await q.sql`
      SELECT u.model AS key, ${rawSums(q)}
        FROM task_usage AS u
       WHERE u.workspace_id = ${q.workspaceId} AND u.issue_id = ${issueId}
       GROUP BY u.model
       ORDER BY cost_micros DESC`;
   return {
      totals: toBucket(totalsRow),
      byRun: byRun.map((row) => toBucket(row)),
      byModel: byModel.map((row) => toBucket(row)),
   };
}

const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

const TASK_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'blocked', 'done', 'cancelled'];

export interface DashboardOverview {
   usageDaily: UsageBucket[];
   runsDaily: Array<{ day: string; total: number; succeeded: number; failed: number; cancelled: number }>;
   failuresByAgent: Array<{ agentId: string; agentName: string; failed: number; total: number }>;
   runCounts: Record<RunStatus, number>;
   workingAgents: Array<{
      runId: string;
      agentId: string;
      agentName: string;
      issueId: string;
      issueTitle: string;
      startedAt: string | null;
   }>;
   taskSnapshot: Record<string, number>;
}

/**
 * The workspace at a glance. Runs have no workspace column before workstream
 * A, so they are scoped through their board. After A, board-less completion
 * tasks (planner, triage, titles) are therefore left out of the run counts on
 * purpose: they are not agent work on a task. Their spend still shows, because
 * usage reads task_usage_hourly, not runs. The task snapshot is every live
 * task now, not only the window's.
 */
export async function dashboardOverview(q: ScopedQuery, window: UsageWindow): Promise<DashboardOverview> {
   const runsInScope = q.sql`
      SELECT r.id, r.agent_id, r.issue_id, r.status, r.created_at, r.started_at
        FROM runs AS r
        JOIN boards AS b ON b.id = r.board_id
       WHERE b.workspace_id = ${q.workspaceId}`;

   const [usageDaily, runsDaily, failures, counts, working, tasks] = await Promise.all([
      hourlyDaily(q, window, {}),
      q.sql`
         SELECT to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(r.id)::bigint AS total,
                COUNT(r.id) FILTER (WHERE r.status = 'succeeded')::bigint AS succeeded,
                COUNT(r.id) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(r.id) FILTER (WHERE r.status = 'cancelled')::bigint AS cancelled
           FROM generate_series(${window.from}::timestamptz, ${window.to}::timestamptz,
                                interval '1 day') AS d(day)
           LEFT JOIN (${runsInScope}) AS r
             ON r.created_at >= d.day AND r.created_at < d.day + interval '1 day'
          GROUP BY d.day
          ORDER BY d.day`,
      q.sql`
         SELECT r.agent_id::text AS agent_id, COALESCE(a.name, 'Removed agent') AS agent_name,
                COUNT(*) FILTER (WHERE r.status = 'failed')::bigint AS failed,
                COUNT(*)::bigint AS total
           FROM (${runsInScope}) AS r
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.created_at >= ${window.from}
          GROUP BY r.agent_id, a.name
         HAVING COUNT(*) FILTER (WHERE r.status = 'failed') > 0
          ORDER BY failed DESC, total DESC
          LIMIT 20`,
      q.sql`
         SELECT r.status::text AS status, COUNT(*)::bigint AS count
           FROM (${runsInScope}) AS r
          WHERE r.created_at >= ${window.from} OR r.status IN ('queued', 'running')
          GROUP BY r.status`,
      q.sql`
         SELECT r.id AS run_id, r.agent_id::text AS agent_id,
                COALESCE(a.name, 'Removed agent') AS agent_name,
                r.issue_id::text AS issue_id, i.title AS issue_title, r.started_at
           FROM (${runsInScope}) AS r
           JOIN issues AS i ON i.id = r.issue_id
           LEFT JOIN agents AS a ON a.id = r.agent_id
          WHERE r.status = 'running'
          ORDER BY r.started_at NULLS LAST
          LIMIT 50`,
      q.sql`
         SELECT i.status::text AS status, COUNT(*)::bigint AS count
           FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
          WHERE b.workspace_id = ${q.workspaceId} AND i.deleted_at IS NULL
          GROUP BY i.status`,
   ]);

   const runCounts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
      RunStatus,
      number
   >;
   for (const row of counts) {
      const status = String(row.status);
      if ((RUN_STATUSES as readonly string[]).includes(status)) {
         runCounts[status as RunStatus] = Number(row.count);
      }
   }

   const taskSnapshot: Record<string, number> = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0])
   );
   for (const row of tasks) {
      const key = issueStatusToApi(String(row.status));
      taskSnapshot[key] = (taskSnapshot[key] ?? 0) + Number(row.count);
   }

   return {
      usageDaily,
      runsDaily: runsDaily.map((row) => ({
         day: String(row.day),
         total: Number(row.total),
         succeeded: Number(row.succeeded),
         failed: Number(row.failed),
         cancelled: Number(row.cancelled),
      })),
      failuresByAgent: failures.map((row) => ({
         agentId: String(row.agent_id),
         agentName: String(row.agent_name),
         failed: Number(row.failed),
         total: Number(row.total),
      })),
      runCounts,
      workingAgents: working.map((row) => ({
         runId: String(row.run_id),
         agentId: String(row.agent_id),
         agentName: String(row.agent_name),
         issueId: String(row.issue_id),
         issueTitle: String(row.issue_title),
         startedAt: row.started_at === null ? null : new Date(String(row.started_at)).toISOString(),
      })),
      taskSnapshot,
   };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle && pnpm typecheck:server && cd server-ts && node --test --experimental-strip-types src/usage/queries.test.ts`
Expected: `tsc` exits 0. Offline, the window test passes and the DB suite skips. With `BERRY_TEST_DATABASE_URL`, all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add server-ts/src/usage/queries.ts server-ts/src/usage/queries.test.ts
git commit -m "feat(server-ts): read usage by workspace, agent, runtime, task, and the dashboard"
```

---

### Task 5: Serve `/api/v1/usage` and `/api/v1/dashboard`

**Files:**
- Create: `server-ts/src/mounts/usage.ts`
- Create: `server-ts/src/mounts/usage.test.ts`
- Modify: `server-ts/src/index.ts` (register the mounts)
- Modify: `server-ts/src/mounts/cross-tenant-leakage.test.ts` (register the mounts, one new test)
- Modify: `server-ts/SCOPE.md` (served block)

**Interfaces:**
- Consumes: everything from Task 4. Also `mountWorkspaceScope`, `pathId` and `ScopedVariables` from `server-ts/src/mounts/shared.ts`; `json` from `server-ts/src/http/app.ts`; `assertValid` and `fieldError` from `server-ts/src/http/body.ts`; `ApiError` from `server-ts/src/http/errors.ts`; `toApiError` from `server-ts/src/identity/errors.ts`.
- Produces: `usageMounts(options: { sessions: SessionService; sql: Sql }): Mount[]` and the routes in the Wire contract.

- [ ] **Step 1: Write the failing test**

`server-ts/src/mounts/usage.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { recordTaskUsage } from '../usage/record.ts';
import { cleanupUsageWorld, seedUsageWorld, type UsageWorld } from '../usage/test-fixtures.ts';
import { usageMounts } from './usage.ts';

/**
 * The usage and dashboard mounts, driven through the real app. What matters
 * beyond the numbers is the boundary: another workspace's agent, task or
 * runtime answers exactly like one that does not exist.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('usage mounts', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let token = '';
   let mine: UsageWorld;
   let theirs: UsageWorld;

   before(async () => {
      sql = openDatabase({ url: url! });
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const registry = new Registry();
      registry.registerAll(usageMounts({ sessions, sql }));
      app = createApp(registry);
      mine = await seedUsageWorld(sql, 'mnt');
      theirs = await seedUsageWorld(sql, 'mnt-other');
      for (const world of [mine, theirs]) {
         await recordTaskUsage(sql, {
            runId: world.runId,
            workspaceId: world.workspaceId,
            agentId: world.agentId,
            model: 'model-a',
            inputTokens: 40,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
         });
      }
      token = (await sessions.issueForUser(mine.userId)).token;
   });

   after(async () => {
      await cleanupUsageWorld(sql, mine);
      await cleanupUsageWorld(sql, theirs);
      await closeDatabase(sql);
   });

   async function get(path: string, auth = true) {
      const response = await app.request(path, {
         headers: auth ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
   }

   test('the workspace summary counts only this workspace', async () => {
      const { status, body } = await get(`/api/v1/usage/${mine.workspaceId}/summary?days=7`);
      assert.equal(status, 200);
      assert.equal(body.currency, 'USD');
      assert.equal(body.days, 7);
      assert.equal((body.totals as { inputTokens: number }).inputTokens, 40);
      assert.equal((body.daily as unknown[]).length, 7);
   });

   test("another workspace's summary is a 404", async () => {
      assert.equal((await get(`/api/v1/usage/${theirs.workspaceId}/summary`)).status, 404);
   });

   test('agent, task and runtime reads refuse ids from another workspace', async () => {
      const base = `/api/v1/usage/${mine.workspaceId}`;
      assert.equal((await get(`${base}/agents/${mine.agentId}`)).status, 200);
      assert.equal((await get(`${base}/agents/${theirs.agentId}`)).status, 404);
      assert.equal((await get(`${base}/issues/${mine.issueId}`)).status, 200);
      assert.equal((await get(`${base}/issues/${theirs.issueId}`)).status, 404);
      assert.equal((await get(`${base}/runtimes/${randomUUID()}`)).status, 404);
      const runtime = await get(`${base}/runtimes/default`);
      assert.equal(runtime.status, 200);
      assert.equal((runtime.body.byHour as unknown[]).length, 24);
   });

   test('the task panel lists the run that spent', async () => {
      const { body } = await get(`/api/v1/usage/${mine.workspaceId}/issues/${mine.issueId}`);
      assert.deepEqual((body.byRun as Array<{ key: string }>).map((row) => row.key), [mine.runId]);
   });

   test('the dashboard answers with run counts and a task snapshot', async () => {
      const { status, body } = await get(`/api/v1/dashboard/${mine.workspaceId}/overview`);
      assert.equal(status, 200);
      assert.equal((body.runCounts as { queued: number }).queued, 1);
      assert.equal((body.taskSnapshot as { todo: number }).todo, 1);
      assert.equal((body.runsDaily as unknown[]).length, 30);
   });

   test('a window outside 1..90 days or an unknown parameter is refused', async () => {
      for (const query of ['days=0', 'days=91', 'days=abc', 'range=7']) {
         const { status, body } = await get(`/api/v1/usage/${mine.workspaceId}/summary?${query}`);
         assert.equal(status, 422, query);
         assert.equal((body.error as { code: string }).code, 'VALIDATION_FAILED');
      }
   });

   test('no session is a 401 before any read', async () => {
      assert.equal((await get(`/api/v1/usage/${mine.workspaceId}/summary`, false)).status, 401);
      assert.equal((await get(`/api/v1/dashboard/${mine.workspaceId}/overview`, false)).status, 401);
   });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/usage.test.ts`
Expected: FAIL, `Cannot find module … usage.ts`.

- [ ] **Step 3: Write the implementation**

`server-ts/src/mounts/usage.ts`:

```ts
import { Hono } from 'hono';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { toApiError } from '../identity/errors.ts';
import type { ScopedDb, ScopedQuery } from '../identity/workspace-context.ts';
import {
   agentUsage,
   dashboardOverview,
   issueInWorkspace,
   issueUsage,
   runtimeUsage,
   runtimeVisible,
   usageWindow,
   workspaceUsage,
   type UsageWindow,
} from '../usage/queries.ts';
import { mountWorkspaceScope, pathId, type ScopedVariables } from './shared.ts';

/**
 * `/api/v1/usage` and `/api/v1/dashboard`.
 *
 * Read-only projections of `task_usage_hourly`, `task_usage`, `runs` and
 * `issues`. Both sit under `/:workspaceId/…`, so the workspace guard confirms
 * membership before a handler runs. Every nested id (agent, task, runtime)
 * is checked against that workspace too, so a foreign id is the same 404 as
 * an absent one.
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

export interface UsageMountOptions {
   sessions: SessionService;
   sql: Sql;
}

export function usageMounts(options: UsageMountOptions): Mount[] {
   return [
      { prefix: '/api/v1/usage', handler: usageRoute(options) },
      { prefix: '/api/v1/dashboard', handler: dashboardRoute(options) },
   ];
}

function usageRoute(options: UsageMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, options);

   route.get('/:workspaceId/summary', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const body = await scopedRead(context.get('scoped'), (q) => workspaceUsage(q, window));
      return json({ ...windowFields(window), ...body });
   });

   route.get('/:workspaceId/agents/:agentId', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      const db = context.get('scoped');
      try {
         await db.requireResource('agents', agentId);
      } catch (error) {
         throw toApiError(error, 'Agent');
      }
      const body = await scopedRead(db, (q) => agentUsage(q, agentId, window));
      return json({ ...windowFields(window), ...body });
   });

   route.get('/:workspaceId/runtimes/:runtimeId', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const raw = context.req.param('runtimeId');
      const runtimeId = raw === 'default' ? null : pathId(raw, 'Runtime');
      const db = context.get('scoped');
      if (runtimeId !== null && !(await scopedRead(db, (q) => runtimeVisible(q, runtimeId)))) {
         throw ApiError.notFound('Runtime');
      }
      const body = await scopedRead(db, (q) => runtimeUsage(q, runtimeId, window));
      return json({ ...windowFields(window), ...body });
   });

   route.get('/:workspaceId/issues/:issueId', async (context) => {
      parseQuery(context.req.url, false);
      const issueId = pathId(context.req.param('issueId'), 'Issue');
      const db = context.get('scoped');
      if (!(await scopedRead(db, (q) => issueInWorkspace(q, issueId)))) {
         throw ApiError.notFound('Issue');
      }
      const body = await scopedRead(db, (q) => issueUsage(q, issueId));
      return json({ currency: 'USD', ...body });
   });

   return route;
}

function dashboardRoute(options: UsageMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, options);

   route.get('/:workspaceId/overview', async (context) => {
      const window = usageWindow(parseQuery(context.req.url, true));
      const body = await scopedRead(context.get('scoped'), (q) => dashboardOverview(q, window));
      return json({ ...windowFields(window), ...body });
   });

   return route;
}

function windowFields(window: UsageWindow) {
   return { currency: 'USD', days: window.days, from: window.from, to: window.to };
}

/**
 * The only query parameter is `days`, and only on windowed reads. An
 * unrecognised parameter is a typo, and a read that ignored it would answer
 * a question nobody asked.
 */
function parseQuery(rawUrl: string, allowDays: boolean): number {
   const params = new URL(rawUrl).searchParams;
   const errors: FieldError[] = [];
   for (const name of new Set(params.keys())) {
      if (!(allowDays && name === 'days')) {
         errors.push(fieldError(`/${name}`, 'unknown', `${name} is not a parameter of this read.`));
      }
   }
   let days = DEFAULT_DAYS;
   const raw = allowDays ? params.get('days') : null;
   if (raw !== null) {
      const parsed = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
      if (!(parsed >= 1 && parsed <= MAX_DAYS)) {
         errors.push(fieldError('/days', 'invalid_value', `days is a whole number from 1 to ${MAX_DAYS}.`));
      } else {
         days = parsed;
      }
   }
   assertValid(errors);
   return days;
}

/** One scoped read that returns a value rather than rows. */
async function scopedRead<T>(db: ScopedDb, read: (q: ScopedQuery) => Promise<T>): Promise<T> {
   const [value] = await db.list(async (q) => [await read(q)]);
   if (value === undefined) throw new Error('a scoped read returned nothing');
   return value;
}
```

In `server-ts/src/index.ts`, add `import { usageMounts } from './mounts/usage.ts';` beside the other mount imports. After the `registry.registerAll(agentMounts({ … }));` line, add:

```ts
registry.registerAll(usageMounts({ sessions, sql }));
```

In `server-ts/src/mounts/cross-tenant-leakage.test.ts`:

1. Add `import { usageMounts } from './usage.ts';` after the `workspaceReadMounts` import.
2. In `before()`, after `registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));`, add `registry.registerAll(usageMounts({ sessions, sql }));`.
3. Directly before the `// -------------------------------------------------------- guarantee (a)` comment, add:

```ts
      test('usage and dashboard reads under a foreign workspace are the same 404 as an absent one', async () => {
         for (const tail of ['/summary', '/runtimes/default', `/agents/${randomUUID()}`, `/issues/${randomUUID()}`]) {
            const foreign = await getAsU1(`/api/v1/usage/${world.w2Id}${tail}`);
            const absent = await getAsU1(`/api/v1/usage/${RANDOM_WORKSPACE}${tail}`);
            assert.equal(foreign.status, 404, tail);
            assert.equal(await foreign.text(), await absent.text(), tail);
         }
         const foreign = await getAsU1(`/api/v1/dashboard/${world.w2Id}/overview`);
         const absent = await getAsU1(`/api/v1/dashboard/${RANDOM_WORKSPACE}/overview`);
         assert.equal(foreign.status, 404);
         assert.equal(await foreign.text(), await absent.text());
      });
```

In `server-ts/SCOPE.md`, replace the served block's first two lines:

```
/api/v1/agents        /api/v1/approvals     /api/v1/attachments   /api/v1/auth
/api/v1/boards        /api/v1/catalogs      /api/v1/comments      /api/v1/config
```

with:

```
/api/v1/agents        /api/v1/approvals     /api/v1/attachments   /api/v1/auth
/api/v1/boards        /api/v1/catalogs      /api/v1/comments      /api/v1/config
/api/v1/dashboard     /api/v1/usage
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /Users/secret/Code/berry-circle && pnpm typecheck:server && pnpm test:server
cd server-ts && grep -rhoE "prefix: '/[^']+'" src/mounts/*.ts | sort -u | grep -E "usage|dashboard"
```
Expected: `tsc` exits 0 and the suite passes (DB suites pass with `BERRY_TEST_DATABASE_URL`, skip without it). The grep prints `prefix: '/api/v1/dashboard'` and `prefix: '/api/v1/usage'`. The server boots, since the registry refuses overlapping prefixes at startup: `pnpm dev:server` logs no registry error.

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add server-ts/src/mounts/usage.ts server-ts/src/mounts/usage.test.ts server-ts/src/index.ts \
  server-ts/src/mounts/cross-tenant-leakage.test.ts server-ts/SCOPE.md
git commit -m "feat(server-ts): serve workspace usage and the dashboard behind the workspace guard"
```

---

### Task 6: Frontend usage client and shared usage components

**Files:**
- Create: `frontend/lib/usage.ts`
- Create: `frontend/components/common/usage/use-usage.ts`
- Create: `frontend/components/common/usage/usage-tiles.tsx`
- Create: `frontend/components/common/usage/usage-daily-chart.tsx`
- Create: `frontend/components/common/usage/usage-breakdown-table.tsx`

**Interfaces:**
- Consumes: the Wire contract; `apiFetch` from `frontend/lib/api.ts`; `subscribeWorkspaceEvents` from `frontend/lib/events.ts`.
- Produces:
  - Types `UsageBucket`, `AgentUsageBucket`, `WorkspaceUsage`, `AgentUsage`, `RuntimeUsage`, `IssueUsage`, `DashboardOverview`
  - Fetchers `getWorkspaceUsage(workspaceId, days)`, `getAgentUsage(workspaceId, agentId, days)`, `getRuntimeUsage(workspaceId, runtimeId | 'default', days)`, `getIssueUsage(workspaceId, issueId)`, `getDashboard(workspaceId, days)`
  - Formatters `formatCost(micros: number): string`, `formatTokens(count: number): string`, `USAGE_DAY_OPTIONS = [7, 30, 90] as const`
  - `useUsage<T>(load: (() => Promise<T>) | null, key: string): { data: T | null; error: string | null; loading: boolean; reload: () => void }`
  - `<UsageTiles totals={UsageBucket} />`, `<UsageDailyChart points={UsageBucket[]} metric="cost" | "tokens" />`, `<UsageBreakdownTable title rows={{ id; label; href?; bucket }[]} />`

- [ ] **Step 1: Write `frontend/lib/usage.ts`**

```ts
import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Usage and dashboard reads. Money arrives as integer USD micros and tokens as
 * integers; formatting happens here, once, so every panel says the same thing.
 */

const bucketSchema = z.object({
   key: z.string(),
   events: z.number(),
   unpricedEvents: z.number(),
   inputTokens: z.number(),
   outputTokens: z.number(),
   cacheReadTokens: z.number(),
   cacheWriteTokens: z.number(),
   costMicros: z.number(),
});

const agentBucketSchema = bucketSchema.extend({ agentName: z.string() });

const windowSchema = z.object({
   currency: z.literal('USD'),
   days: z.number(),
   from: z.string(),
   to: z.string(),
});

const workspaceUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byModel: z.array(bucketSchema),
});

const agentUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
});

const runtimeUsageSchema = windowSchema.extend({
   totals: bucketSchema,
   daily: z.array(bucketSchema),
   byAgent: z.array(agentBucketSchema),
   byHour: z.array(bucketSchema),
});

const issueUsageSchema = z.object({
   currency: z.literal('USD'),
   totals: bucketSchema,
   byRun: z.array(bucketSchema),
   byModel: z.array(bucketSchema),
});

const dashboardSchema = windowSchema.extend({
   usageDaily: z.array(bucketSchema),
   runsDaily: z.array(
      z.object({
         day: z.string(),
         total: z.number(),
         succeeded: z.number(),
         failed: z.number(),
         cancelled: z.number(),
      })
   ),
   failuresByAgent: z.array(
      z.object({ agentId: z.string(), agentName: z.string(), failed: z.number(), total: z.number() })
   ),
   runCounts: z.object({
      queued: z.number(),
      running: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      cancelled: z.number(),
   }),
   workingAgents: z.array(
      z.object({
         runId: z.string(),
         agentId: z.string(),
         agentName: z.string(),
         issueId: z.string(),
         issueTitle: z.string(),
         startedAt: z.string().nullable(),
      })
   ),
   taskSnapshot: z.record(z.string(), z.number()),
});

export type UsageBucket = z.infer<typeof bucketSchema>;
export type AgentUsageBucket = z.infer<typeof agentBucketSchema>;
export type WorkspaceUsage = z.infer<typeof workspaceUsageSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;
export type IssueUsage = z.infer<typeof issueUsageSchema>;
export type DashboardOverview = z.infer<typeof dashboardSchema>;

export const USAGE_DAY_OPTIONS = [7, 30, 90] as const;

function base(workspaceId: string): string {
   return `/api/v1/usage/${encodeURIComponent(workspaceId)}`;
}

async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
   const json: unknown = await apiFetch(path);
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error('Usage response was not recognized');
   return parsed.data;
}

export function getWorkspaceUsage(workspaceId: string, days: number): Promise<WorkspaceUsage> {
   return read(`${base(workspaceId)}/summary?days=${days}`, workspaceUsageSchema);
}

export function getAgentUsage(workspaceId: string, agentId: string, days: number): Promise<AgentUsage> {
   return read(`${base(workspaceId)}/agents/${encodeURIComponent(agentId)}?days=${days}`, agentUsageSchema);
}

export function getRuntimeUsage(
   workspaceId: string,
   runtimeId: string,
   days: number
): Promise<RuntimeUsage> {
   return read(
      `${base(workspaceId)}/runtimes/${encodeURIComponent(runtimeId)}?days=${days}`,
      runtimeUsageSchema
   );
}

export function getIssueUsage(workspaceId: string, issueId: string): Promise<IssueUsage> {
   return read(`${base(workspaceId)}/issues/${encodeURIComponent(issueId)}`, issueUsageSchema);
}

export function getDashboard(workspaceId: string, days: number): Promise<DashboardOverview> {
   return read(
      `/api/v1/dashboard/${encodeURIComponent(workspaceId)}/overview?days=${days}`,
      dashboardSchema
   );
}

/** Micros to dollars, with more places for small amounts so a cheap run is not "$0.00". */
export function formatCost(micros: number): string {
   const dollars = micros / 1_000_000;
   if (micros === 0) return '$0';
   return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(count: number): string {
   return compact.format(count);
}

export function totalTokens(bucket: UsageBucket): number {
   return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
}
```

- [ ] **Step 2: Write `frontend/components/common/usage/use-usage.ts`**

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeWorkspaceEvents } from '@/lib/events';

export interface UsageState<T> {
   data: T | null;
   error: string | null;
   loading: boolean;
   reload: () => void;
}

/** A busy workspace reports usage on every model call; refresh at most this often. */
const REFRESH_DEBOUNCE_MS = 2000;

/**
 * Loads one usage read and reloads it when the workspace stream says usage
 * was recorded. `key` names the read, so changing the window or the subject
 * refetches; `load` may be null until the workspace is known.
 */
export function useUsage<T>(load: (() => Promise<T>) | null, key: string): UsageState<T> {
   const [data, setData] = useState<T | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);
   const [tick, setTick] = useState(0);
   const loadRef = useRef(load);
   loadRef.current = load;
   const reload = useCallback(() => setTick((value) => value + 1), []);

   useEffect(() => {
      const current = loadRef.current;
      if (!current) return;
      let cancelled = false;
      setLoading(true);
      current()
         .then((value) => {
            if (cancelled) return;
            setData(value);
            setError(null);
         })
         .catch((cause: unknown) => {
            if (!cancelled) {
               setError(cause instanceof Error ? cause.message : 'Usage could not be loaded.');
            }
         })
         .finally(() => {
            if (!cancelled) setLoading(false);
         });
      return () => {
         cancelled = true;
      };
   }, [key, tick]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (event.type !== 'usage.recorded' || timer) return;
         timer = setTimeout(() => {
            timer = null;
            reload();
         }, REFRESH_DEBOUNCE_MS);
      });
      return () => {
         if (timer) clearTimeout(timer);
         unsubscribe();
      };
   }, [reload]);

   return { data, error, loading, reload };
}
```

- [ ] **Step 3: Write the three presentational components**

`frontend/components/common/usage/usage-tiles.tsx`:

```tsx
import { formatCost, formatTokens, type UsageBucket } from '@/lib/usage';

/** Cost and the four token counts for one window, with the unpriced caveat when it applies. */
export function UsageTiles({ totals }: { totals: UsageBucket }) {
   const tiles = [
      { label: 'Cost', value: formatCost(totals.costMicros) },
      { label: 'Input tokens', value: formatTokens(totals.inputTokens) },
      { label: 'Output tokens', value: formatTokens(totals.outputTokens) },
      {
         label: 'Cache read / write',
         value: `${formatTokens(totals.cacheReadTokens)} / ${formatTokens(totals.cacheWriteTokens)}`,
      },
   ];
   return (
      <div className="flex flex-col gap-2">
         <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((tile) => (
               <div key={tile.label} className="rounded-md border px-4 py-3">
                  <p className="text-muted-foreground">{tile.label}</p>
                  <p className="mt-1 text-lg font-medium tabular-nums">{tile.value}</p>
               </div>
            ))}
         </div>
         {totals.unpricedEvents > 0 ? (
            <p className="text-muted-foreground">
               {totals.unpricedEvents} of {totals.events} usage reports used a model with no published
               price. Their tokens are counted here; their cost is not.
            </p>
         ) : null}
      </div>
   );
}
```

`frontend/components/common/usage/usage-daily-chart.tsx`:

```tsx
'use client';

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatCost, formatTokens, totalTokens, type UsageBucket } from '@/lib/usage';

/** One bar per bucket. Keys are days (`YYYY-MM-DD`) or hours (`00`..`23`). */
export function UsageDailyChart({
   points,
   metric,
}: {
   points: UsageBucket[];
   metric: 'cost' | 'tokens';
}) {
   const data = points.map((point) => ({
      key: point.key.length === 10 ? point.key.slice(5) : point.key,
      value: metric === 'cost' ? point.costMicros : totalTokens(point),
   }));
   const format = metric === 'cost' ? formatCost : formatTokens;
   return (
      <div className="h-48 w-full text-foreground/70">
         <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
               <XAxis dataKey="key" tickLine={false} axisLine={false} fontSize={11} minTickGap={12} />
               <YAxis hide />
               <Tooltip
                  cursor={{ fillOpacity: 0.08 }}
                  formatter={(value) => [format(Number(value)), metric === 'cost' ? 'Cost' : 'Tokens']}
               />
               <Bar dataKey="value" fill="currentColor" radius={[2, 2, 0, 0]} />
            </BarChart>
         </ResponsiveContainer>
      </div>
   );
}
```

`frontend/components/common/usage/usage-breakdown-table.tsx`:

```tsx
import Link from 'next/link';

import { formatCost, formatTokens, totalTokens, type UsageBucket } from '@/lib/usage';

export interface BreakdownRow {
   id: string;
   label: string;
   href?: string;
   bucket: UsageBucket;
}

/** Rows ranked as the server sent them (by cost), with an honest empty state. */
export function UsageBreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
   return (
      <section className="flex flex-col gap-2">
         <h3 className="font-medium">{title}</h3>
         {rows.length === 0 ? (
            <p className="text-muted-foreground">No usage in this window.</p>
         ) : (
            <div className="overflow-x-auto">
               <table className="w-full">
                  <thead className="text-left text-muted-foreground">
                     <tr>
                        <th className="py-1 pr-4 font-normal">Name</th>
                        <th className="py-1 pr-4 text-right font-normal">Reports</th>
                        <th className="py-1 pr-4 text-right font-normal">Tokens</th>
                        <th className="py-1 text-right font-normal">Cost</th>
                     </tr>
                  </thead>
                  <tbody>
                     {rows.map((row) => (
                        <tr key={row.id} className="border-t">
                           <td className="max-w-[20rem] truncate py-1.5 pr-4">
                              {row.href ? (
                                 <Link href={row.href} className="hover:underline">
                                    {row.label}
                                 </Link>
                              ) : (
                                 row.label
                              )}
                           </td>
                           <td className="py-1.5 pr-4 text-right tabular-nums">{row.bucket.events}</td>
                           <td className="py-1.5 pr-4 text-right tabular-nums">
                              {formatTokens(totalTokens(row.bucket))}
                           </td>
                           <td className="py-1.5 text-right tabular-nums">
                              {formatCost(row.bucket.costMicros)}
                              {row.bucket.unpricedEvents > 0 ? '*' : ''}
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>
         )}
      </section>
   );
}
```

- [ ] **Step 4: Lint and build**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm prettier --write lib/usage.ts components/common/usage && pnpm lint && pnpm build:check`
Expected: lint passes with no errors in the new files, and `next build` succeeds. The new modules are unused so far, which is fine for the build.

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add frontend/lib/usage.ts frontend/components/common/usage
git commit -m "feat(frontend): add the usage client and shared usage components"
```

---

### Task 7: The Usage page

**Files:**
- Create: `frontend/components/common/usage/runtime-usage-panel.tsx`
- Create: `frontend/components/common/usage/usage-overview.tsx`
- Create: `frontend/components/layout/headers/usage/header.tsx`
- Create: `frontend/app/[orgId]/usage/page.tsx`
- Modify: `frontend/components/layout/shell/shell-routes.ts`, `frontend/store/sidebar-prefs-store.ts`, `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`

**Interfaces:**
- Consumes: Task 6 exports; `useSessionStore` from `frontend/store/session-store.ts` (`state.workspace?.id`).
- Produces: route `/{orgId}/usage`; `SidebarItemKey` `'usage'`; `ShellRoute` `'usage'`; `<RuntimeUsagePanel runtimeId={string} days={number} />` (workstream A mounts it on the runtime detail page with a runtime's uuid).

- [ ] **Step 1: Write the runtime panel and the page body**

`frontend/components/common/usage/runtime-usage-panel.tsx`:

```tsx
'use client';

import { useParams } from 'next/navigation';

import { getRuntimeUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/**
 * One runtime's usage by day, by agent and by hour of day (UTC). `'default'`
 * is the workspace's default runtime; a runtime detail page passes its id.
 */
export function RuntimeUsagePanel({ runtimeId, days }: { runtimeId: string; days: number }) {
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const { data, error } = useUsage(
      workspaceId ? () => getRuntimeUsage(workspaceId, runtimeId, days) : null,
      `${workspaceId}:${runtimeId}:${days}`
   );
   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!data) return <p className="text-muted-foreground">Loading usage…</p>;
   return (
      <div className="flex flex-col gap-6">
         <UsageTiles totals={data.totals} />
         <div className="grid gap-6 lg:grid-cols-2">
            <div>
               <h3 className="mb-2 font-medium">By day</h3>
               <UsageDailyChart points={data.daily} metric="cost" />
            </div>
            <div>
               <h3 className="mb-2 font-medium">By hour of day (UTC)</h3>
               <UsageDailyChart points={data.byHour} metric="tokens" />
            </div>
         </div>
         <UsageBreakdownTable
            title="By agent"
            rows={data.byAgent.map((row) => ({
               id: row.key,
               label: row.agentName,
               href: `/${orgId}/agents/${row.key}`,
               bucket: row,
            }))}
         />
      </div>
   );
}
```

`frontend/components/common/usage/usage-overview.tsx`:

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { USAGE_DAY_OPTIONS, getWorkspaceUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { RuntimeUsagePanel } from './runtime-usage-panel';
import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

/** The workspace's model spend: totals, a daily chart, and who and what spent it. */
export default function UsageOverview() {
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error, loading } = useUsage(
      workspaceId ? () => getWorkspaceUsage(workspaceId, days) : null,
      `${workspaceId}:${days}`
   );

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <div className="flex items-center gap-1">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="sm"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {option} days
               </Button>
            ))}
            {loading ? <span className="ml-2 text-muted-foreground">Refreshing…</span> : null}
         </div>

         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <UsageTiles totals={data.totals} />
               <section>
                  <h3 className="mb-2 font-medium">Cost by day</h3>
                  <UsageDailyChart points={data.daily} metric="cost" />
               </section>
               <div className="grid gap-8 lg:grid-cols-2">
                  <UsageBreakdownTable
                     title="By agent"
                     rows={data.byAgent.map((row) => ({
                        id: row.key,
                        label: row.agentName,
                        href: `/${orgId}/agents/${row.key}`,
                        bucket: row,
                     }))}
                  />
                  <UsageBreakdownTable
                     title="By model"
                     rows={data.byModel.map((row) => ({ id: row.key, label: row.key, bucket: row }))}
                  />
               </div>
               <section className="flex flex-col gap-2">
                  <h3 className="font-medium">Default runtime</h3>
                  <RuntimeUsagePanel runtimeId="default" days={days} />
               </section>
            </>
         ) : null}
      </div>
   );
}
```

- [ ] **Step 2: Write the header and the page**

`frontend/components/layout/headers/usage/header.tsx`:

```tsx
export default function Header() {
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Usage</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Model tokens and cost across the workspace, priced when each run reports them.
            </p>
         </div>
      </header>
   );
}
```

`frontend/app/[orgId]/usage/page.tsx`:

```tsx
import { Suspense } from 'react';

import UsageOverview from '@/components/common/usage/usage-overview';
import Header from '@/components/layout/headers/usage/header';
import MainLayout from '@/components/layout/main-layout';

export default function UsagePage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Suspense>
            <UsageOverview />
         </Suspense>
      </MainLayout>
   );
}
```

- [ ] **Step 3: Add the rail item (append only; leave `analytics` to workstream I)**

- `frontend/store/sidebar-prefs-store.ts`: add `| 'usage'` to `SidebarItemKey`. Add `'usage': 'always',` to `DEFAULT_VISIBILITY`. Append `'usage'` to the end of `DEFAULT_ORDER.configure`.
- `frontend/components/layout/shell/shell-routes.ts`: add `| 'usage'` to `ShellRoute`. Append this to the end of the `MANAGE` array:
  ```ts
     {
        id: 'usage',
        label: 'usage',
        href: '/usage',
        prefsKey: 'usage',
        icon: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.7c0 2.6-5 1.3-5 4 0 1.1 1 1.8 2.5 1.8s2.5-.5 2.5-1.5" />',
     },
  ```
- `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`: add `Coins` to the `lucide-react` import. Append `{ key: 'usage', label: 'usage', icon: Coins },` to `CONFIGURE_ITEMS`.
- `frontend/components/layout/shell/shell-tab-model.ts`: no change. `SECTION_LABELS` lists only labels that differ from their path segment, and `usage` does not.

- [ ] **Step 4: Lint, build and check the view**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm prettier --write "app/[orgId]/usage" components/common/usage components/layout/headers/usage components/layout/shell components/layout/sidebar/customize-sidebar-dialog.tsx store/sidebar-prefs-store.ts && pnpm lint && pnpm build:check`
Expected: both pass. Manual check with `pnpm dev:server` and `pnpm dev:frontend` running: the rail shows **usage** under Manage. `/{orgId}/usage` renders tiles, the chart, the By agent and By model tables and the Default runtime panel. Switching 7/30/90 refetches (the Network tab shows `?days=`). A fresh workspace shows zeros and "No usage in this window."

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add "frontend/app/[orgId]/usage" frontend/components/common/usage frontend/components/layout/headers/usage \
  frontend/components/layout/shell/shell-routes.ts \
  frontend/components/layout/sidebar/customize-sidebar-dialog.tsx frontend/store/sidebar-prefs-store.ts
git commit -m "feat(frontend): add the Usage page"
```

---

### Task 8: The Dashboard page

**Files:**
- Create: `frontend/components/common/usage/dashboard-overview.tsx`
- Create: `frontend/components/layout/headers/dashboard/header.tsx`
- Create: `frontend/app/[orgId]/dashboard/page.tsx`
- Modify: the same three rail files as Task 7 (`shell-routes.ts`, `sidebar-prefs-store.ts`, `customize-sidebar-dialog.tsx`)

**Interfaces:**
- Consumes: `getDashboard`, `DashboardOverview`, `useUsage`, `UsageDailyChart`, `USAGE_DAY_OPTIONS` (Task 6).
- Produces: route `/{orgId}/dashboard`; `SidebarItemKey` `'dashboard'`; `ShellRoute` `'dashboard'`.

- [ ] **Step 1: Write the dashboard body**

`frontend/components/common/usage/dashboard-overview.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import { USAGE_DAY_OPTIONS, getDashboard } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageDailyChart } from './usage-daily-chart';
import { useUsage } from './use-usage';

const TASK_LABELS: Record<string, string> = {
   backlog: 'Backlog',
   todo: 'To do',
   inProgress: 'In progress',
   inReview: 'In review',
   blocked: 'Blocked',
   done: 'Done',
   cancelled: 'Cancelled',
};

/** The workspace at a glance: what is running, what failed, what it cost, where tasks stand. */
export default function DashboardOverview() {
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error } = useUsage(
      workspaceId ? () => getDashboard(workspaceId, days) : null,
      `${workspaceId}:${days}`
   );

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <div className="flex items-center gap-1">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="sm"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {option} days
               </Button>
            ))}
         </div>
         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  {(['running', 'queued', 'succeeded', 'failed', 'cancelled'] as const).map((status) => (
                     <div key={status} className="rounded-md border px-4 py-3">
                        <p className="capitalize text-muted-foreground">{status}</p>
                        <p className="mt-1 text-lg font-medium tabular-nums">{data.runCounts[status]}</p>
                     </div>
                  ))}
               </div>

               <section>
                  <h3 className="mb-2 font-medium">Runs by day</h3>
                  <div className="h-48 w-full">
                     <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                           data={data.runsDaily.map((row) => ({ ...row, key: row.day.slice(5) }))}
                           margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
                        >
                           <XAxis dataKey="key" tickLine={false} axisLine={false} fontSize={11} minTickGap={12} />
                           <YAxis hide allowDecimals={false} />
                           <Tooltip cursor={{ fillOpacity: 0.08 }} />
                           <Bar dataKey="succeeded" stackId="runs" fill="var(--color-status-success, currentColor)" />
                           <Bar dataKey="failed" stackId="runs" fill="var(--color-status-error, currentColor)" />
                           <Bar dataKey="cancelled" stackId="runs" fill="var(--color-muted-foreground, currentColor)" />
                        </BarChart>
                     </ResponsiveContainer>
                  </div>
               </section>

               <section>
                  <h3 className="mb-2 font-medium">Cost by day</h3>
                  <UsageDailyChart points={data.usageDaily} metric="cost" />
               </section>

               <div className="grid gap-8 lg:grid-cols-2">
                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">Working now</h3>
                     {data.workingAgents.length === 0 ? (
                        <p className="text-muted-foreground">No agent is running.</p>
                     ) : (
                        <ul className="flex flex-col gap-1.5">
                           {data.workingAgents.map((row) => (
                              <li key={row.runId} className="flex items-center justify-between gap-3">
                                 <Link href={`/${orgId}/agents/${row.agentId}`} className="shrink-0 hover:underline">
                                    {row.agentName}
                                 </Link>
                                 <Link
                                    href={`/${orgId}/runs?run=${row.runId}`}
                                    className="truncate text-muted-foreground hover:underline"
                                 >
                                    {row.issueTitle}
                                 </Link>
                              </li>
                           ))}
                        </ul>
                     )}
                  </section>

                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">Failures by agent</h3>
                     {data.failuresByAgent.length === 0 ? (
                        <p className="text-muted-foreground">No failed runs in this window.</p>
                     ) : (
                        <ul className="flex flex-col gap-1.5">
                           {data.failuresByAgent.map((row) => (
                              <li key={row.agentId} className="flex items-center justify-between gap-3">
                                 <Link href={`/${orgId}/agents/${row.agentId}`} className="hover:underline">
                                    {row.agentName}
                                 </Link>
                                 <span className="tabular-nums text-muted-foreground">
                                    {row.failed} of {row.total}
                                 </span>
                              </li>
                           ))}
                        </ul>
                     )}
                  </section>
               </div>

               <section className="flex flex-col gap-2">
                  <h3 className="font-medium">Tasks now</h3>
                  <div className="flex flex-wrap gap-2">
                     {Object.entries(data.taskSnapshot).map(([status, count]) => (
                        <span key={status} className="rounded-md border px-3 py-1.5">
                           {TASK_LABELS[status] ?? status}{' '}
                           <span className="tabular-nums text-muted-foreground">{count}</span>
                        </span>
                     ))}
                  </div>
               </section>
            </>
         ) : null}
      </div>
   );
}
```

- [ ] **Step 2: Header and page**

`frontend/components/layout/headers/dashboard/header.tsx`:

```tsx
export default function Header() {
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Dashboard</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Runs, failures, spend and task status for the whole workspace.
            </p>
         </div>
      </header>
   );
}
```

`frontend/app/[orgId]/dashboard/page.tsx`:

```tsx
import { Suspense } from 'react';

import DashboardOverview from '@/components/common/usage/dashboard-overview';
import Header from '@/components/layout/headers/dashboard/header';
import MainLayout from '@/components/layout/main-layout';

export default function DashboardPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Suspense>
            <DashboardOverview />
         </Suspense>
      </MainLayout>
   );
}
```

- [ ] **Step 3: Rail item (append only)**

- `frontend/store/sidebar-prefs-store.ts`: add `| 'dashboard'` to `SidebarItemKey`, and `'dashboard': 'always',` to `DEFAULT_VISIBILITY`. Insert `'dashboard'` into `DEFAULT_ORDER.configure` directly before `'usage'`.
- `frontend/components/layout/shell/shell-routes.ts`: add `| 'dashboard'` to `ShellRoute`. Insert this into `MANAGE` directly before the `usage` entry:
  ```ts
     {
        id: 'dashboard',
        label: 'dashboard',
        href: '/dashboard',
        prefsKey: 'dashboard',
        icon: '<rect x="4" y="4" width="7" height="9" rx="1" /><rect x="13" y="4" width="7" height="5" rx="1" /><rect x="13" y="11" width="7" height="9" rx="1" /><rect x="4" y="15" width="7" height="5" rx="1" />',
     },
  ```
- `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`: add `LayoutDashboard` to the `lucide-react` import. Insert `{ key: 'dashboard', label: 'dashboard', icon: LayoutDashboard },` into `CONFIGURE_ITEMS` directly before the `usage` item.
- `frontend/components/layout/shell/shell-tab-model.ts`: no change (the label equals the path segment).

- [ ] **Step 4: Lint, build and check the view**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm prettier --write "app/[orgId]/dashboard" components/common/usage/dashboard-overview.tsx components/layout/headers/dashboard components/layout/shell components/layout/sidebar/customize-sidebar-dialog.tsx store/sidebar-prefs-store.ts && pnpm lint && pnpm build:check`
Expected: both pass. Manual check: the rail shows **dashboard** then **usage** under Manage. `/{orgId}/dashboard` shows run counts, runs by day, cost by day, working now, failures by agent and tasks now. Assigning a task to an agent makes it appear under Working now after a reload.

- [ ] **Step 5: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add "frontend/app/[orgId]/dashboard" frontend/components/common/usage/dashboard-overview.tsx \
  frontend/components/layout/headers/dashboard frontend/components/layout/shell/shell-routes.ts \
  frontend/components/layout/sidebar/customize-sidebar-dialog.tsx \
  frontend/store/sidebar-prefs-store.ts
git commit -m "feat(frontend): add the workspace Dashboard page"
```

---

### Task 9: Usage panels on the task and agent pages

**Files:**
- Create: `frontend/components/common/usage/issue-usage-section.tsx`
- Create: `frontend/components/common/usage/agent-usage-tab.tsx`
- Modify: `frontend/components/common/issues/details/issue-properties-panel.tsx`
- Modify: `frontend/components/common/agents/agent-details.tsx:47` (`DETAIL_TABS`) and the tab contents

**Interfaces:**
- Consumes: `getIssueUsage`, `getAgentUsage`, `useUsage`, `UsageTiles`, `UsageDailyChart`, `UsageBreakdownTable` (Task 6); `Section` from `frontend/components/common/issues/details/panel-section.tsx`.
- Produces: `<IssueUsageSection issueId={string} />`, `<AgentUsageTab agentId={string} />`. The runtime panel (`RuntimeUsagePanel`) was produced in Task 7 for workstream A's runtime page.

- [ ] **Step 1: Write the two panels**

`frontend/components/common/usage/issue-usage-section.tsx`:

```tsx
'use client';

import { Section } from '@/components/common/issues/details/panel-section';
import { formatCost, formatTokens, getIssueUsage, totalTokens } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { useUsage } from './use-usage';

/** What the agents' work on this task has cost so far, across every run. */
export function IssueUsageSection({ issueId }: { issueId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const { data, error } = useUsage(
      workspaceId ? () => getIssueUsage(workspaceId, issueId) : null,
      `${workspaceId}:${issueId}`
   );
   if (error || !data) return null;
   return (
      <Section title="Usage">
         {data.totals.events === 0 ? (
            <p className="text-muted-foreground">No model usage yet.</p>
         ) : (
            <div className="flex flex-col gap-1">
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="tabular-nums">
                     {formatCost(data.totals.costMicros)}
                     {data.totals.unpricedEvents > 0 ? '*' : ''}
                  </span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tokens</span>
                  <span className="tabular-nums">{formatTokens(totalTokens(data.totals))}</span>
               </div>
               <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Runs</span>
                  <span className="tabular-nums">{data.byRun.length}</span>
               </div>
            </div>
         )}
      </Section>
   );
}
```

`frontend/components/common/usage/agent-usage-tab.tsx`:

```tsx
'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { USAGE_DAY_OPTIONS, getAgentUsage } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageBreakdownTable } from './usage-breakdown-table';
import { UsageDailyChart } from './usage-daily-chart';
import { UsageTiles } from './usage-tiles';
import { useUsage } from './use-usage';

export function AgentUsageTab({ agentId }: { agentId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error } = useUsage(
      workspaceId ? () => getAgentUsage(workspaceId, agentId, days) : null,
      `${workspaceId}:${agentId}:${days}`
   );
   return (
      <div className="flex flex-col gap-6">
         <div className="flex items-center gap-1">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="sm"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {option} days
               </Button>
            ))}
         </div>
         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <UsageTiles totals={data.totals} />
               <UsageDailyChart points={data.daily} metric="cost" />
               <UsageBreakdownTable
                  title="By model"
                  rows={data.byModel.map((row) => ({ id: row.key, label: row.key, bucket: row }))}
               />
            </>
         ) : null}
      </div>
   );
}
```

- [ ] **Step 2: Mount them**

In `frontend/components/common/issues/details/issue-properties-panel.tsx`, add the import `import { IssueUsageSection } from '@/components/common/usage/issue-usage-section';`. Directly after the line `<IssueApprovalSection issue={issue} />`, add:

```tsx
               <IssueUsageSection issueId={issue.id} />
```

In `frontend/components/common/agents/agent-details.tsx`:
- Add the import `import { AgentUsageTab } from '@/components/common/usage/agent-usage-tab';`.
- Change line 47 to `const DETAIL_TABS = ['overview', 'work', 'model', 'usage', 'settings'] as const;`.
- Directly before the line `<TabsContent value="settings" className="mt-0 flex flex-col gap-6 px-8 py-6">`, add:

```tsx
               <TabsContent value="usage" className="mt-0 px-8 py-6">
                  <AgentUsageTab agentId={agentId} />
               </TabsContent>
```

**Runtime detail page (spec: "usage panels on … runtime").** Workstream A's plan creates `frontend/components/common/runtimes/runtime-detail.tsx` but does not mount a usage panel, so C does it when that file exists:
- Run `test -f frontend/components/common/runtimes/runtime-detail.tsx && echo present`.
- If `present`: add `import { RuntimeUsagePanel } from '@/components/common/usage/runtime-usage-panel';` and render `<RuntimeUsagePanel runtimeId={runtime.id} days={30} />` as the last section of the detail body. Use whatever variable holds the loaded runtime's id in that component, and add the file to this task's `prettier` and `git add` lists.
- If absent (A has not merged): make no change, and put "runtime detail usage panel: mount `RuntimeUsagePanel` when A's runtime-detail.tsx lands" in the PR description as an open follow-up. Do not create A's file.

- [ ] **Step 3: Lint, build and check both views**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm prettier --write components/common/usage components/common/issues/details/issue-properties-panel.tsx components/common/agents/agent-details.tsx && pnpm lint && pnpm build:check`
Expected: both pass. Manual check with server and frontend running, after one agent run finishes on a task:
- The task page sidebar shows **usage** with a non-zero cost (`*` only if the model has no Portkey price), tokens and runs.
- The agent page has a **usage** tab with tiles, a chart and a By model table.
- `/{orgId}/runs` shows the run's `costMicros` as non-null. This is the spec's "costMicros always null" fix, checked end to end.

- [ ] **Step 4: Final gates, then commit**

Run: `cd /Users/secret/Code/berry-circle && pnpm typecheck:server && pnpm test:server && cd frontend && pnpm lint && pnpm build:check`
Expected: all pass.

```bash
cd /Users/secret/Code/berry-circle
git add frontend/components/common/usage frontend/components/common/issues/details/issue-properties-panel.tsx \
  frontend/components/common/agents/agent-details.tsx
git commit -m "feat(frontend): show usage on the task and agent pages"
```

---

## Self-review

**Spec coverage (section 4):**
- `task_usage` holds one row per `task.usage` event, and `task_usage_hourly` is an upsert rollup maintained on write → Task 2. A's hook is `recordTaskUsage`, and the in-process bridge is Task 3.
- Cost comes from the price table `agents/catalog.ts` already fetches, computed on write, which fixes `costMicros` always being null → Task 1 (one shared parser, now with cache prices), Task 2 (cost on write, run totals recomputed, ledger never clobbers), Task 3 (the in-process path actually calls it), and the end-to-end check in Task 9.
- Endpoints: issue, agent and runtime usage (daily, by agent, by hour), plus the workspace dashboard (daily usage, failures daily and by agent, working agents, 30-day activity, run counts, task snapshot) → Tasks 4–5. `runsDaily` carries failures per day, and over a 30-day window it is the activity series. `runCounts`, `workingAgents`, `failuresByAgent` and `taskSnapshot` cover the rest.
- UI: the Usage page → Task 7. The Dashboard page → Task 8. Usage panels on the task and agent pages → Task 9. The runtime panel is a component (Task 7) that A's runtime detail page mounts, and it already shows on the Usage page for the default runtime.
- Tenant boundary on the write path: `recordTaskUsage` derives the run's workspace from the board, or from A's `runs.workspace_id` once A makes `board_id` nullable. It also requires `agentId` to be the run's agent. Both are tested (Task 2).
- Section 11: every table has `workspace_id`; mounts sit behind `mountWorkspaceScope`; they are added to the cross-tenant test (Task 5); `node --test` covers the repository and mounts; the frontend is gated by lint and build.
- Realtime via the outbox: `usage.recorded` (Task 2, written to `outbox_events` and registered in `WORKSPACE_TOPICS` so the workspace SSE stream actually carries it), consumed by `useUsage` (Task 6).
- Runtime usage panel: mounted on A's runtime detail page in Task 9 when that page exists. Otherwise it is an explicit follow-up, and meanwhile the default runtime's panel shows on the Usage page.

**Placeholder scan:** no TBD or TODO steps. Every code step carries code, and every run step has a command and an expected result.

**Type consistency:** `TaskUsageInput` matches the contract signature. `UsageBucket` fields match between `queries.ts` and `frontend/lib/usage.ts`. The route paths (`/summary`, `/agents/:id`, `/runtimes/:id|default`, `/issues/:id`, `/dashboard/:ws/overview`) match across Tasks 5, 6 and the Wire contract. `AccountingSnapshot.cacheReadTokens` and `cacheWriteTokens` match between Task 3's plugin, `usageRecordFor` and its test.
