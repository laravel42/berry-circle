import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '@strands-agents/sdk';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { LocalSession } from './local-session.ts';
import { RemoteToolsUnavailable, collectFileTool, loadRemoteTools } from './remote-tools.ts';

function fakeBerry(calls: Array<{ url: string; body: unknown; auth: string | null }>): typeof fetch {
   return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization');
      if (url.endsWith('/api/v1/agent-tools') && (!init?.method || init.method === 'GET')) {
         return Response.json({
            tools: [
               {
                  name: 'read_task',
                  description: 'Read the task',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
               },
               {
                  name: 'attach_file',
                  description: 'Attach',
                  inputSchema: { type: 'object', properties: { path: { type: 'string' }, base64: { type: 'string' } } },
               },
            ],
         });
      }
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), auth });
      return Response.json({ result: { title: 'The task' } });
   }) as typeof fetch;
}

test('manifest tools are callable by the model and carry the task token', async () => {
   const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
   const api = { apiUrl: 'https://berry.test', token: 'berry_task_x', fetch: fakeBerry(calls) };
   const tools = await loadRemoteTools(api);
   const agent = new Agent({
      model: new ScriptedModel([call('read_task', {}), say('read it')]),
      tools,
      printer: false,
   });
   await agent.invoke('go');
   assert.equal(calls[0]!.url, 'https://berry.test/api/v1/agent-tools/read_task');
   assert.equal(calls[0]!.auth, 'Bearer berry_task_x');
});

test('an unreadable manifest is an error, not a toolless agent', async () => {
   const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
   await assert.rejects(loadRemoteTools({ apiUrl: 'https://b', token: 't', fetch: failing }), RemoteToolsUnavailable);
});

test('collect_file uploads a workspace file through attach_file', async () => {
   const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
   const api = { apiUrl: 'https://berry.test', token: 't', fetch: fakeBerry(calls) };
   const session = new LocalSession({ id: 's', root: mkdtempSync(join(tmpdir(), 'berry-collect-')) });
   await session.writeFile('out/a.txt', 'bytes');
   const agent = new Agent({
      model: new ScriptedModel([call('collect_file', { path: 'out/a.txt' }), say('saved')]),
      tools: [collectFileTool(api, async () => session)],
      printer: false,
   });
   await agent.invoke('go');
   const body = calls[0]!.body as { path: string; base64: string };
   assert.equal(body.path, 'out/a.txt');
   assert.equal(Buffer.from(body.base64, 'base64').toString(), 'bytes');
});
