import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What the runtime image ships, proven from the imports.
 *
 * The image copies only the files below (see sandbox/agentcore/Dockerfile).
 * Every non-test module under src/agents/runtime/ must reach nothing else —
 * a stray value import of the ledger or the pool would crash the container
 * at boot, or quietly ship the server into it.
 */
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const CONTAINER_ALLOWED_FILES = [
   'src/agents/runtime/',
   'src/agents/permissions.ts',
   'src/agents/checkout.ts',
   'src/agents/delivery.ts',
   'src/agents/verification.ts',
   'src/agents/workspace-files.ts',
   'src/execution/driver.ts',
   'src/execution/bytes.ts',
   'src/runtime/envelope.ts',
   'src/runtime/lifecycle.ts',
   'src/scm/commit-trailer.ts',
];
const ALLOWED_PACKAGES = new Set([
   '@strands-agents/sdk',
   'zod',
   '@aws-sdk/client-bedrock-runtime',
   '@aws-sdk/client-polly',
   '@aws-sdk/client-s3',
]);
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gms;

function entries(): string[] {
   const root = join(SERVER_ROOT, 'src/agents/runtime');
   return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(root, file));
}

test('the runtime modules reach only what the image ships', () => {
   const seen = new Set<string>();
   const problems: string[] = [];
   const queue = entries();
   while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = relative(SERVER_ROOT, file);
      if (!CONTAINER_ALLOWED_FILES.some((allowed) => rel === allowed || (allowed.endsWith('/') && rel.startsWith(allowed)))) {
         problems.push(`${rel} is imported but not shipped`);
         continue;
      }
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
         if (match[1]) continue;
         const specifier = match[2]!;
         if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
         else if (!specifier.startsWith('node:') && !ALLOWED_PACKAGES.has(specifier)) {
            problems.push(`${rel} imports package ${specifier}`);
         }
      }
   }
   assert.deepEqual(problems, []);
});
