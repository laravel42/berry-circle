import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Migration 100, read as text. Offline on purpose: the guarantees here are
 * about what the file declares — every table scoped to a workspace, one
 * claim per cron slot, and nothing of the retired rules engine — and none of
 * them needs a database to check.
 */
const text = readFileSync(new URL('../../migrations/100_autopilots.up.sql', import.meta.url), 'utf8');

function tables(): Map<string, string> {
   const found = new Map<string, string>();
   for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      found.set(match[1] ?? '', match[2] ?? '');
   }
   return found;
}

test('the migration creates exactly the autopilot tables', () => {
   assert.deepEqual([...tables().keys()].sort(), [
      'autopilot_members',
      'autopilot_runs',
      'autopilot_triggers',
      'autopilot_versions',
      'autopilots',
      'sys_cron_executions',
      'webhook_deliveries',
   ]);
});

test('every table it creates belongs to a workspace and goes with it', () => {
   for (const [name, body] of tables()) {
      assert.match(
         body,
         /workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/,
         `${name} must carry workspace_id`
      );
   }
});

test('a cron slot can be claimed once: unique on trigger and slot', () => {
   assert.match(tables().get('sys_cron_executions') ?? '', /UNIQUE \(trigger_id, slot\)/);
});

test('a webhook token is stored as a hash, never as itself', () => {
   const triggers = tables().get('autopilot_triggers') ?? '';
   assert.match(triggers, /webhook_token_hash bytea/);
   assert.doesNotMatch(triggers, /webhook_token text/);
   assert.match(triggers, /signing_secret_sealed bytea/);
});

test('the retired rules engine is not brought back', () => {
   assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS automation/);
   assert.doesNotMatch(text, /REFERENCES automation/);
});
