import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import type { ExecResult, ExecutionSession } from '../execution/driver.ts';
import type { BerryArtifactService, SaveArtifactRequest } from './artifact-service.ts';
import type { Sql } from '../db/pool.ts';
import { berryTools } from './tools.ts';

/**
 * collect_file, against a real shell in a temporary directory: the tool's
 * job is to move bytes a command left behind, so a fake that matches command
 * strings would test the wrong thing.
 */
async function harness(): Promise<{
   root: string;
   saved: SaveArtifactRequest[];
   collect: (input: { path: string; as?: string }, workdir?: string) => Promise<Record<string, unknown>>;
}> {
   const root = await mkdtemp(`${tmpdir()}/berry-collect-`);
   const session: ExecutionSession = {
      id: 's',
      exec: async (command: string, options?: { cwd?: string }): Promise<ExecResult> => {
         const result = spawnSync('/bin/bash', ['-c', command], { cwd: options?.cwd ?? root, maxBuffer: 64 * 1024 * 1024 });
         return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), exitCode: result.status ?? 1 };
      },
      stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   };
   const saved: SaveArtifactRequest[] = [];
   const artifacts = {
      saveArtifact: async (request: SaveArtifactRequest) => {
         saved.push(request);
         return 0;
      },
   } as unknown as BerryArtifactService;
   const tools = berryTools({
      sql: {} as Sql,
      artifacts,
      workspaceId: 'w',
      issueId: 'i',
      commands: { ledger: {} as never, runId: 'r', session: async () => session },
   });
   const collect = tools.find((t) => t.name === 'collect_file')!;
   return {
      root,
      saved,
      collect: async (input, workdir) => {
         const appState = new Map<string, unknown>(workdir ? [['workdir', workdir]] : []);
         const context = { agent: { appState } } as unknown as ToolContext;
         const result = await (collect as unknown as { invoke: (i: unknown, c: ToolContext) => Promise<unknown> }).invoke(input, context);
         return result as Record<string, unknown>;
      },
   };
}

test('a file a command produced is saved on the task, bytes intact, type sniffed', async () => {
   const { root, saved, collect } = await harness();
   // The four bytes an MP4 container starts with, then noise: what ffmpeg leaves.
   const clip = Buffer.concat([Buffer.from('\0\0\0\x18ftypisom'), Buffer.from([0, 255, 1, 254, 128])]);
   spawnSync('/bin/bash', ['-c', 'mkdir -p output'], { cwd: root });
   await writeFile(`${root}/output/final.mp4`, clip);

   const result = await collect({ path: 'output/final.mp4', as: 'video/teaser_with_voice.mp4' });

   assert.equal(result.saved, true);
   assert.equal(result.path, 'video/teaser_with_voice.mp4');
   assert.equal(result.sizeBytes, clip.byteLength);
   assert.equal(saved[0]!.filename, 'video/teaser_with_voice.mp4');
   assert.ok(Buffer.from(saved[0]!.artifact.inlineData!.data, 'base64').equals(clip));
   assert.equal(saved[0]!.artifact.inlineData!.mimeType, undefined, 'left for the store to sniff');
});

test('the path is read where run_command runs, so a checkout-relative path works', async () => {
   const { root, saved, collect } = await harness();
   spawnSync('/bin/bash', ['-c', 'mkdir -p repo/dist && printf built > repo/dist/app.js'], { cwd: root });

   const result = await collect({ path: 'dist/app.js' }, `${root}/repo`);

   assert.equal(result.saved, true);
   assert.equal(saved[0]!.filename, 'dist/app.js');
});

test('a file that is not there is reported, not thrown, and nothing is saved', async () => {
   const { saved, collect } = await harness();
   const result = await collect({ path: 'output/missing.mp4' });
   assert.equal(result.found, false);
   assert.match(String(result.error), /no file at output\/missing\.mp4/);
   assert.equal(saved.length, 0);
});
