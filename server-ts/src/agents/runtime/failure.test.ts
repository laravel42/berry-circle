import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, ModelThrottledError } from '@strands-agents/sdk';
import { BerryRetryStrategy, classify, httpStatus, isTransient } from './failure.ts';
import { ScriptedModel, say, throwing } from './scripted-model.ts';

/**
 * How a failure is read. Pinned against the shape AWS SDK v3 actually throws —
 * `$metadata.httpStatusCode` and a named error — because the previous reader
 * looked at `.status`, which AWS never sets, and so classified every throttle
 * as a non-retryable runtime error (F-22).
 */

/** A captured ThrottlingException, shaped as the AWS SDK throws it. */
function throttling(): Error {
   const error = new Error('Too many requests, please wait before trying again.');
   error.name = 'ThrottlingException';
   Object.assign(error, {
      $fault: 'client',
      $metadata: { httpStatusCode: 429, requestId: 'r', attempts: 1, totalRetryDelay: 0 },
      $retryable: { throttling: true },
   });
   return error;
}

function validation(): Error {
   const error = new Error('The provided model identifier is invalid.');
   error.name = 'ValidationException';
   Object.assign(error, { $metadata: { httpStatusCode: 400 } });
   return error;
}

test('the status is read from where AWS puts it', () => {
   assert.equal(httpStatus(throttling()), 429);
   assert.equal(httpStatus(validation()), 400);
   assert.equal(httpStatus(new Error('plain')), null);
   assert.equal(httpStatus({ status: 503 }), 503);
});

test('a throttle is transient and a bad model id is not', () => {
   assert.equal(isTransient(throttling()), true);
   assert.equal(isTransient(validation()), false);
   assert.equal(isTransient(new ModelThrottledError('slow down')), true);
   assert.equal(isTransient(new Error('x')), false);
});

test('classification names the failure and whether to try again', () => {
   assert.deepEqual(classify(throttling()), {
      code: 'RATE_LIMITED',
      message: 'Too many requests, please wait before trying again.',
      retryable: true,
   });
   assert.equal(classify(validation()).code, 'UPSTREAM_REJECTED');
   assert.equal(classify(validation()).retryable, false);
   const server = new Error('boom');
   Object.assign(server, { $metadata: { httpStatusCode: 503 } });
   assert.equal(classify(server).code, 'UPSTREAM_UNAVAILABLE');
   assert.equal(classify(new Error('x')).code, 'RUNTIME_ERROR');
});

test('the strategy retries a throttle and gives up on a rejection', async () => {
   const retried = new ScriptedModel([throwing(throttling()), say('ok')]);
   const agent = new Agent({
      model: retried,
      retryStrategy: new BerryRetryStrategy({ maxAttempts: 3, baseDelayMs: 1 }),
      printer: false,
   });
   const result = await agent.invoke('go');
   assert.equal(result.stopReason, 'endTurn');
   assert.equal(retried.calls, 2);

   const rejected = new ScriptedModel([throwing(validation()), say('never')]);
   const stubborn = new Agent({
      model: rejected,
      retryStrategy: new BerryRetryStrategy({ maxAttempts: 3, baseDelayMs: 1 }),
      printer: false,
   });
   await assert.rejects(stubborn.invoke('go'), /invalid/);
   assert.equal(rejected.calls, 1);
});
