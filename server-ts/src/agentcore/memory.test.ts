import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentCoreRunMemory, nullRunMemory, recallPrompt } from './memory.ts';

/**
 * Run recall against a fake client.
 *
 * Two properties carry the feature, and they are what these assert. First, the
 * keying: an actor is the agent and a session is the issue, so "this agent, on
 * this issue" is one query and two issues cannot see each other. Second, that
 * nothing here can fail a run — memory is a convenience over the run ledger,
 * and the ledger is what actually has to be right.
 */

const AGENT = 'agent-uuid';
const ISSUE = 'issue-uuid';

interface FakeEvent {
   eventTimestamp?: Date;
   payload?: Array<{ conversational?: { role?: string; content?: { text?: string } } }>;
}

function fake(options: { events?: FakeEvent[]; fails?: boolean } = {}) {
   const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
   const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
         sent.push({ name: command.constructor.name, input: command.input });
         if (options.fails) throw new Error('memory unreachable');
         if (command.constructor.name === 'ListEventsCommand') {
            return { events: options.events ?? [] };
         }
         return { event: { eventId: 'event-1' } };
      },
   };
   return { sent, client: client as never };
}

function memory(f: ReturnType<typeof fake>, clock?: () => Date) {
   return new AgentCoreRunMemory({
      region: 'us-east-1',
      memoryId: 'berry_run_recall-test',
      client: f.client,
      ...(clock ? { clock } : {}),
   });
}

function event(text: string, seconds: number, role = 'ASSISTANT'): FakeEvent {
   return {
      eventTimestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
      payload: [{ conversational: { role, content: { text } } }],
   };
}

test('an actor is the agent and a session is the issue, so recall is scoped to both', async () => {
   const f = fake();
   await memory(f).recall({ agentId: AGENT, issueId: ISSUE });
   const [call] = f.sent;
   assert.equal(call!.name, 'ListEventsCommand');
   assert.equal(call!.input.actorId, `agent-${AGENT}`);
   assert.equal(call!.input.sessionId, `issue-${ISSUE}`);
   // Without payloads the events come back as timestamps with no content, which
   // is a recall that recalls nothing.
   assert.equal(call!.input.includePayloads, true);
});

test('recall returns events oldest first, whatever order they arrive in', async () => {
   // ListEvents returns newest first, and recall is read as a story.
   const f = fake({ events: [event('third', 30), event('first', 10), event('second', 20)] });
   const recalled = await memory(f).recall({ agentId: AGENT, issueId: ISSUE });
   assert.deepEqual(
      recalled.map((entry) => entry.text),
      ['first', 'second', 'third']
   );
});

test('an event with no text or no timestamp is skipped rather than recalled empty', async () => {
   const f = fake({
      events: [
         event('real', 10),
         { eventTimestamp: new Date(), payload: [{ conversational: { content: { text: '  ' } } }] },
         { payload: [{ conversational: { content: { text: 'no timestamp' } } }] },
         { eventTimestamp: new Date(), payload: [] },
      ],
   });
   const recalled = await memory(f).recall({ agentId: AGENT, issueId: ISSUE });
   assert.deepEqual(
      recalled.map((entry) => entry.text),
      ['real']
   );
});

test('an unrecognised role is reported as OTHER rather than trusted through', async () => {
   const f = fake({ events: [event('text', 10, 'SOMETHING_NEW')] });
   const [recalled] = await memory(f).recall({ agentId: AGENT, issueId: ISSUE });
   assert.equal(recalled!.role, 'OTHER');
});

test('a recorded event carries the run it came from, so a recalled line is traceable', async () => {
   const at = new Date(Date.UTC(2026, 0, 1));
   const f = fake();
   await memory(f, () => at).record({
      agentId: AGENT,
      issueId: ISSUE,
      role: 'ASSISTANT',
      text: 'did a thing',
      runId: 'run-7',
   });
   const [call] = f.sent;
   assert.equal(call!.name, 'CreateEventCommand');
   assert.equal(call!.input.actorId, `agent-${AGENT}`);
   assert.equal(call!.input.sessionId, `issue-${ISSUE}`);
   assert.deepEqual(call!.input.eventTimestamp, at);
   assert.deepEqual(call!.input.payload, [
      { conversational: { role: 'ASSISTANT', content: { text: 'did a thing' } } },
   ]);
   assert.deepEqual(call!.input.metadata, { runId: { stringValue: 'run-7' } });
});

test('an empty event is not sent at all: it is a charge nothing can read', async () => {
   const f = fake();
   await memory(f).record({ agentId: AGENT, issueId: ISSUE, role: 'ASSISTANT', text: '   \n  ' });
   assert.equal(f.sent.length, 0);
});

test('a huge event is truncated to its tail, because the tail is where the failure is', async () => {
   const f = fake();
   await memory(f).record({
      agentId: AGENT,
      issueId: ISSUE,
      role: 'ASSISTANT',
      text: `${'a'.repeat(9000)}THE_END`,
   });
   const payload = f.sent[0]!.input.payload as Array<{
      conversational: { content: { text: string } };
   }>;
   const text = payload[0]!.conversational.content.text;
   assert.equal(text.length, 4001, 'capped at 4000 plus the elision mark');
   assert.ok(text.startsWith('…'), 'the cut is visible');
   assert.ok(text.endsWith('THE_END'), 'the tail survives, not the head');
});

test('a store that cannot be reached costs recall, not the run', async () => {
   const failures: string[] = [];
   const broken = new AgentCoreRunMemory({
      region: 'us-east-1',
      memoryId: 'berry_run_recall-test',
      client: fake({ fails: true }).client,
      onError: (operation) => failures.push(operation),
   });
   // Both resolve. A throw here would fail a run over a convenience.
   assert.deepEqual(await broken.recall({ agentId: AGENT, issueId: ISSUE }), []);
   await broken.record({ agentId: AGENT, issueId: ISSUE, role: 'ASSISTANT', text: 'dropped' });
   assert.deepEqual(failures, ['recall', 'record']);
});

test('the disabled seam is present and does nothing', async () => {
   const off = nullRunMemory();
   assert.equal(off.enabled, false);
   assert.deepEqual(await off.recall({ agentId: AGENT, issueId: ISSUE }), []);
   await off.record({ agentId: AGENT, issueId: ISSUE, role: 'ASSISTANT', text: 'ignored' });
});

test('a first run gets no recall prompt, because it has no last time', () => {
   // Null rather than a heading with nothing under it: an empty list reads as a
   // claim that nothing was done, which is not the same as never having run.
   assert.equal(recallPrompt([]), null);
});

test('a recall prompt lists what happened and says not to repeat it', () => {
   const prompt = recallPrompt([
      { at: new Date(), role: 'ASSISTANT', text: 'ran the tests' },
      { at: new Date(), role: 'ASSISTANT', text: 'fixed one failure' },
   ]);
   assert.match(prompt!, /worked on this issue before/);
   assert.match(prompt!, /- ran the tests/);
   assert.match(prompt!, /- fixed one failure/);
   assert.match(prompt!, /Do not repeat work that already succeeded/);
});
