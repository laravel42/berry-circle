import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * GitHub is the only sign-in method. These pin that the password path is
 * gone rather than merely unrouted, so it cannot come back by a stray import.
 */

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
   return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
   });
}

test('the password modules no longer exist', () => {
   assert.equal(existsSync(join(SRC, 'auth', 'password.ts')), false);
   assert.equal(existsSync(join(SRC, 'auth', 'schemas.ts')), false);
});

test('no server source reads or writes a user password column', () => {
   const offenders = sources(SRC).filter((file) =>
      /password_hash|password_salt|hashPassword|verifyPassword|createUserWithPassword/.test(
         readFileSync(file, 'utf8')
      )
   );
   assert.deepEqual(offenders, []);
});
