import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { emitterSink } from './emitter.ts';

test('every ledger write becomes one task.message', async () => {
   const events: LifecycleEvent[] = [];
   const sink = emitterSink((event) => events.push(event));
   await sink.appendOutput('run', 'progress', 'hello');
   await sink.appendToolStarted('run', 'c1', 'run_command');
   await sink.appendToolCompleted('run', 'c1', true);
   await sink.appendCommandStarted('run', { commandId: 'k', command: 'ls', cwd: null });
   await sink.appendCommandOutput('run', { commandId: 'k', stream: 'stdout', text: 'a' });
   await sink.appendCommandCompleted('run', { commandId: 'k', exitCode: 0, durationMs: 3, truncated: false });
   assert.deepEqual(
      events.map((event) => (event.type === 'task.message' ? event.message.kind : event.type)),
      ['output', 'tool.started', 'tool.completed', 'command.started', 'command.output', 'command.completed']
   );
});
