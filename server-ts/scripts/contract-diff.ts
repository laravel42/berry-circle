/**
 * Compares this server's responses against the Go server's, path by path.
 *
 * The migration has no OpenAPI document to check against — for most of the
 * surface the Go implementation *is* the contract. So the check is empirical:
 * ask both servers the same question and compare what comes back, including
 * key order, because the frontend compares whole bodies.
 *
 * Run before moving a mount to capture the target, and after to prove it.
 *
 *   node --experimental-strip-types scripts/contract-diff.ts /health /ready
 *
 * Volatile fields are normalised rather than ignored: a request id differs by
 * design and a timestamp moves, but the *shape* of both must still match, so
 * they are replaced with a marker instead of being deleted.
 */

const GO = process.env.GO_BASE_URL ?? 'http://127.0.0.1:4000';
const TS = process.env.TS_BASE_URL ?? 'http://127.0.0.1:4100';

/**
 * A bearer token, when the paths under test need one. Both servers read the
 * same database during the migration, so one token authenticates against both.
 */
const BEARER = process.env.BEARER;

/** One request to ask of both servers. */
interface Probe {
   method?: string;
   path: string;
   body?: unknown;
   headers?: Record<string, string>;
   /** Shown instead of the path when several probes share one path. */
   label?: string;
}

/** Fields that legitimately differ between two processes answering the same call. */
const VOLATILE = /^(requestId|createdAt|updatedAt|startedAt|completedAt|readyAt|occurredAt|timestamp|id)$/;

interface Comparison {
   path: string;
   status: { go: number; ts: number };
   identical: boolean;
   /** Equal once request ids and timestamps are blanked: a passing result. */
   volatileOnly: boolean;
   sameShape: boolean;
   go: unknown;
   ts: unknown;
}

function request(base: string, probe: Probe): Promise<Response> {
   const headers: Record<string, string> = { ...probe.headers };
   if (BEARER) headers.authorization = `Bearer ${BEARER}`;
   if (probe.body !== undefined) headers['content-type'] ??= 'application/json';
   return fetch(base + probe.path, {
      method: probe.method ?? 'GET',
      headers,
      body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
   });
}

/**
 * Asks both servers the same question — one after the other, never at once.
 *
 * Concurrent requests would race on a write probe: both servers share a
 * database, so the second read could see the first write and report a
 * difference that is ordering, not contract.
 */
async function fetchBoth(probe: Probe): Promise<Comparison> {
   const path = probe.label ?? `${probe.method ?? 'GET'} ${probe.path}`;
   const goResponse = await request(GO, probe).catch(() => undefined);
   const tsResponse = await request(TS, probe).catch(() => undefined);
   if (!goResponse || !tsResponse) {
      throw new Error(`could not reach ${!goResponse ? GO : TS} — is it running?`);
   }
   const go: unknown = await parse(goResponse);
   const ts: unknown = await parse(tsResponse);
   return {
      path,
      status: { go: goResponse.status, ts: tsResponse.status },
      identical: JSON.stringify(go) === JSON.stringify(ts),
      volatileOnly: JSON.stringify(blank(go)) === JSON.stringify(blank(ts)),
      sameShape: JSON.stringify(normalise(go)) === JSON.stringify(normalise(ts)),
      go,
      ts,
   };
}

async function parse(response: Response): Promise<unknown> {
   const text = await response.text();
   try {
      return JSON.parse(text);
   } catch {
      return text;
   }
}

/**
 * Replaces volatile leaf values with their type, keeping keys and their order.
 *
 * Two bodies with the same shape differ only in data; two with different
 * shapes differ in contract, and that is the distinction worth reporting.
 */
/**
 * Blanks volatile leaf values while comparing everything else exactly.
 *
 * Stricter than `normalise`: a request id differs between two processes by
 * design, but every other byte still has to match. Without this, the only
 * difference on a correctly ported endpoint — its request id — reads the same
 * as a genuinely wrong field, and across 36 mounts that noise hides the
 * findings worth acting on.
 */
function blank(value: unknown): unknown {
   if (Array.isArray(value)) return value.map(blank);
   if (value === null || typeof value !== 'object') return value;
   const out: Record<string, unknown> = {};
   for (const [key, nested] of Object.entries(value)) {
      out[key] = VOLATILE.test(key) ? '<volatile>' : blank(nested);
   }
   return out;
}

function normalise(value: unknown): unknown {
   if (Array.isArray(value)) return value.map(normalise);
   if (value === null || typeof value !== 'object') return typeof value;
   const out: Record<string, unknown> = {};
   for (const [key, nested] of Object.entries(value)) {
      out[key] = VOLATILE.test(key) ? `<${typeof nested}>` : normalise(nested);
   }
   return out;
}

const argv = process.argv.slice(2);
let probes: Probe[];
if (argv[0] === '--spec') {
   // A spec file carries methods and bodies, so write paths can be compared
   // too. Reads alone would leave every PATCH in the migration unchecked.
   const specPath = argv[1];
   if (!specPath) {
      console.error('usage: contract-diff.ts --spec <file.json>');
      process.exit(2);
   }
   const { readFile } = await import('node:fs/promises');
   probes = JSON.parse(await readFile(specPath, 'utf8')) as Probe[];
} else if (argv.length > 0) {
   probes = argv.map((path) => ({ path }));
} else {
   console.error('usage: contract-diff.ts <path> [path...]   |   --spec <file.json>');
   process.exit(2);
}

let mismatches = 0;
for (const probe of probes) {
   const result = await fetchBoth(probe);
   const verdict = result.identical
      ? 'identical'
      : result.volatileOnly
        ? 'identical apart from request ids and timestamps'
        : result.sameShape
          ? 'SAME SHAPE, DIFFERENT DATA'
          : 'CONTRACT DIFFERS';
   const passed = result.volatileOnly && result.status.go === result.status.ts;
   if (!passed) mismatches += 1;

   console.log(`${result.path}`);
   console.log(`  status   go=${result.status.go} ts=${result.status.ts}`);
   console.log(`  verdict  ${verdict}`);
   if (!result.identical && !result.volatileOnly) {
      console.log(`  go       ${JSON.stringify(result.go)}`);
      console.log(`  ts       ${JSON.stringify(result.ts)}`);
   }
   console.log('');
}

if (mismatches > 0) {
   console.error(`${mismatches} path(s) differ beyond request ids and timestamps.`);
   process.exit(1);
}
console.log('Every path matches, request ids and timestamps aside.');
