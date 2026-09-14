/**
 * What went wrong reaching an external system, in Berry's vocabulary.
 *
 * The point is that no caller should have to know whether the failure came
 * from AgentCore, from MCP's JSON-RPC envelope, or from GitHub underneath it.
 * Three layers each have their own way of saying "not found", and a domain
 * service that had to recognise all three would be coupled to every one of
 * them.
 *
 * `cause` keeps the original, because normalising a message and losing the
 * evidence is how a diagnosable failure becomes a shrug.
 */

export type SourceControlErrorKind =
   | 'authentication'
   | 'authorization'
   | 'not_found'
   | 'conflict'
   | 'rate_limit'
   | 'gateway_unavailable'
   | 'validation';

export class SourceControlError extends Error {
   override readonly name: string = 'SourceControlError';
   readonly kind: SourceControlErrorKind;
   /**
    * Whether trying the identical call again could plausibly succeed.
    *
    * Read before a retry, and deliberately false for `conflict`: a duplicate
    * is the one failure where retrying makes the problem worse.
    */
   readonly retryable: boolean;
   /** The gateway's own request id, for correlating with AWS's logs. */
   readonly requestId: string | null;

   constructor(
      message: string,
      kind: SourceControlErrorKind,
      options: { cause?: unknown; requestId?: string | null } = {}
   ) {
      super(message, options.cause === undefined ? undefined : { cause: options.cause });
      this.kind = kind;
      this.retryable = kind === 'rate_limit' || kind === 'gateway_unavailable';
      this.requestId = options.requestId ?? null;
   }
}

export class SourceControlAuthenticationError extends SourceControlError {
   override readonly name = 'SourceControlAuthenticationError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'authentication', options);
   }
}

export class SourceControlAuthorizationError extends SourceControlError {
   override readonly name = 'SourceControlAuthorizationError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'authorization', options);
   }
}

export class SourceControlNotFoundError extends SourceControlError {
   override readonly name = 'SourceControlNotFoundError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'not_found', options);
   }
}

export class SourceControlConflictError extends SourceControlError {
   override readonly name = 'SourceControlConflictError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'conflict', options);
   }
}

export class SourceControlRateLimitError extends SourceControlError {
   override readonly name = 'SourceControlRateLimitError';
   /** When the host said it would accept another call, when it said. */
   readonly retryAfterMs: number | null;
   constructor(
      message: string,
      options: { cause?: unknown; requestId?: string | null; retryAfterMs?: number | null } = {}
   ) {
      super(message, 'rate_limit', options);
      this.retryAfterMs = options.retryAfterMs ?? null;
   }
}

export class SourceControlGatewayUnavailableError extends SourceControlError {
   override readonly name = 'SourceControlGatewayUnavailableError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'gateway_unavailable', options);
   }
}

export class SourceControlValidationError extends SourceControlError {
   override readonly name = 'SourceControlValidationError';
   constructor(message: string, options?: { cause?: unknown; requestId?: string | null }) {
      super(message, 'validation', options);
   }
}

/**
 * A capability the gateway does not offer.
 *
 * Raised at startup rather than at the first call. A deployment whose gateway
 * cannot create an issue should fail while somebody is watching it boot, not
 * an hour later when a plan compiles and a task silently never appears.
 */
export class ToolUnavailableError extends SourceControlError {
   override readonly name = 'ToolUnavailableError';
   readonly capability: string;
   readonly available: string[];
   constructor(capability: string, available: string[]) {
      super(
         `the gateway exposes no tool for ${capability}; it offers: ${available.slice(0, 40).join(', ') || '(nothing)'}`,
         'validation'
      );
      this.capability = capability;
      this.available = available;
   }
}

/**
 * An HTTP status, as Berry reads it.
 *
 * Shared so the gateway and any direct client agree: a 403 meaning "your
 * credential is fine, this account is not allowed" must not be reported as an
 * authentication failure that a reconnection would fix.
 */
export function errorForStatus(
   status: number,
   message: string,
   options: { cause?: unknown; requestId?: string | null; retryAfterMs?: number | null } = {}
): SourceControlError {
   if (status === 401) return new SourceControlAuthenticationError(message, options);
   if (status === 403) return new SourceControlAuthorizationError(message, options);
   if (status === 404) return new SourceControlNotFoundError(message, options);
   if (status === 409) return new SourceControlConflictError(message, options);
   if (status === 422) return new SourceControlValidationError(message, options);
   if (status === 429) return new SourceControlRateLimitError(message, options);
   if (status >= 500 || status === 0) {
      return new SourceControlGatewayUnavailableError(message, options);
   }
   return new SourceControlError(message, 'validation', options);
}
