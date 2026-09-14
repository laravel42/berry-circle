import { DefaultModelRetryStrategy, ExponentialBackoff, ModelThrottledError } from '@strands-agents/sdk';
import type { Failure } from '../../runs/ledger.ts';
import { truncateUtf8 } from './utf8.ts';

/**
 * How a model failure is read, in one place.
 *
 * Retrying and reporting used to disagree: the single-completion client
 * retried on the AWS error name while the run path classified on a `.status`
 * field that AWS SDK v3 never sets, so a Bedrock throttle was recorded as a
 * non-retryable runtime error — the one case a retryable flag exists for.
 * One predicate now serves both.
 */

const TRANSIENT_NAMES = new Set([
   'ThrottlingException',
   'ModelTimeoutException',
   'ServiceUnavailableException',
   'InternalServerException',
   'TooManyRequestsException',
]);

/**
 * The HTTP status an error carries, wherever its SDK put it.
 *
 * Follows `cause`: the agent SDK wraps a provider's error in its own, and the
 * status is on the one underneath.
 */
export function httpStatus(error: unknown): number | null {
   if (typeof error !== 'object' || error === null) return null;
   const source = error as {
      $metadata?: { httpStatusCode?: unknown };
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
   };
   const candidates = [source.$metadata?.httpStatusCode, source.status, source.statusCode];
   for (const candidate of candidates) {
      if (typeof candidate === 'number') return candidate;
   }
   return source.cause !== undefined && source.cause !== error ? httpStatus(source.cause) : null;
}

/**
 * Whether trying again could plausibly work.
 *
 * Deliberately narrow. A retryable failure invites another paid run, and an
 * agent's tools have side effects, so anything not clearly transient is final.
 */
export function isTransient(error: unknown): boolean {
   if (error instanceof ModelThrottledError) return true;
   const name = (error as { name?: unknown })?.name;
   if (typeof name === 'string' && TRANSIENT_NAMES.has(name)) return true;
   const status = httpStatus(error);
   if (status === 429 || (status !== null && status >= 500)) return true;
   // The SDK wraps a provider error; the name is on the one underneath.
   const cause = (error as { cause?: unknown })?.cause;
   return cause !== undefined && cause !== error && isTransient(cause);
}

/**
 * The provider refused to produce the output, as opposed to failing to.
 *
 * Bedrock reports its content filter as a model error whose text names the
 * policy — seen live when an agent set out to put a song's real lyrics
 * into a speech tool. It is not transient and not a bug in the run, and a
 * person can only fix it by changing what was asked, so it gets a name and
 * a message that says that.
 */
const BLOCKED = /content filter|content filtering|guardrail|blocked by/i;

export function isContentBlocked(error: unknown): boolean {
   const message = (error as { message?: unknown })?.message;
   if (typeof message === 'string' && BLOCKED.test(message)) return true;
   const cause = (error as { cause?: unknown })?.cause;
   return cause !== undefined && cause !== error && isContentBlocked(cause);
}

export function classify(error: unknown): Failure {
   if (isContentBlocked(error)) {
      return {
         code: 'CONTENT_BLOCKED',
         message:
            "The model provider's content filter blocked what the agent was producing, so the run could not continue. " +
            'This is not a transient error: change what the task asks for (for example, original lyrics instead of a ' +
            `copyrighted song) and run it again. Provider message: ${truncateUtf8(String((error as Error)?.message ?? error), 500)}`,
         retryable: false,
      };
   }
   const status = httpStatus(error);
   const throttled = error instanceof ModelThrottledError || status === 429;
   const code = throttled
      ? 'RATE_LIMITED'
      : status !== null && status >= 500
        ? 'UPSTREAM_UNAVAILABLE'
        : status !== null
          ? 'UPSTREAM_REJECTED'
          : 'RUNTIME_ERROR';
   return {
      code,
      message: truncateUtf8(String((error as Error)?.message ?? error), 2_000),
      retryable: isTransient(error),
   };
}

export interface RetryOptions {
   maxAttempts?: number;
   baseDelayMs?: number;
}

/**
 * The SDK's retry loop with Berry's idea of transient.
 *
 * Passed as `retryStrategy` on every agent Berry builds — replacing the
 * SDK's default rather than joining it — so a throttled model call is retried
 * with backoff inside the SDK and only its final failure reaches `classify`.
 */
export class BerryRetryStrategy extends DefaultModelRetryStrategy {
   override readonly name = 'berry:retry';

   constructor(options: RetryOptions = {}) {
      super({
         maxAttempts: options.maxAttempts ?? 4,
         ...(options.baseDelayMs === undefined
            ? {}
            : { backoff: new ExponentialBackoff({ baseMs: options.baseDelayMs, maxMs: options.baseDelayMs * 8 }) }),
      });
   }

   protected override isRetryable(error: Error): boolean {
      return isTransient(error);
   }
}
