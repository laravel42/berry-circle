/**
 * The execution seam.
 *
 * Berry runs an agent's commands somewhere that is not Berry. Where that is
 * differs by deployment and must keep differing: a self-hosted Berry runs them
 * in a local container on its own Docker daemon, and a managed one runs them in
 * AWS Bedrock AgentCore — a Code Interpreter session or a deployed Runtime.
 *
 * So this file is the only thing the rest of the server is allowed to know
 * about execution. Nothing above it imports a substrate's type, and no driver
 * leaks its vocabulary upward — the event names here are Berry's, not any
 * provider's, which is what lets a second driver drop in without touching the
 * ledger, the tools or the executor.
 *
 * The seam is deliberately small. Everything an agent needs to do to a working
 * tree is a command, a file write, or a read; anything richer belongs in the
 * agent's prompt rather than in this interface.
 */

/** A command that ran to completion, with the exit code the ledger records. */
export interface ExecResult {
   stdout: string;
   stderr: string;
   /** 0 is success. A signalled process reports the conventional 128+n. */
   exitCode: number;
}

/**
 * One thing that happened while a command ran.
 *
 * `seq` is assigned by the driver and is monotonic within a single stream. It
 * exists so a consumer can say where it got to: today the executor writes
 * events straight to `run_events`, and when the buffering session lands, the
 * same number is the resume cursor. Emitting it now costs nothing and means
 * the wire format does not have to change later.
 */
export type ExecEvent =
   | { type: 'start'; seq: number; command: string }
   | { type: 'stdout'; seq: number; data: string }
   | { type: 'stderr'; seq: number; data: string }
   | { type: 'exit'; seq: number; exitCode: number }
   | { type: 'error'; seq: number; message: string };

export interface ExecOptions {
   /** Relative to the session's root unless absolute. */
   cwd?: string;
   env?: Record<string, string>;
   /**
    * Wall-clock ceiling. Absent means the driver's own default applies —
    * never "unlimited", because a hung command with no ceiling holds a
    * container open until something else reaps it.
    */
   timeoutMs?: number;
   /**
    * Stops the command before it finishes.
    *
    * This is how cancelling a run reaches a `pnpm test` that is three minutes
    * in. Without it the model call can be abandoned while the command it was
    * waiting on runs to completion, holding the container open — the run reads
    * as cancelled while the work carries on behind it.
    */
   signal?: AbortSignal;
}

export interface CreateSessionInput {
   /**
    * Berry's run id. Used as the workspace identity, so a retry of the same
    * run reaches the same workspace rather than a fresh one.
    */
   runId: string;
   /** Starting directory. Defaults to the driver's workspace root. */
   cwd?: string;
   /**
    * Environment for every command in the session. Secrets belong here rather
    * than in a command string, which is recorded in the ledger verbatim.
    */
   env?: Record<string, string>;
}

/**
 * One run's working tree and shell state.
 *
 * Sessions are not reused across runs. The page's promise — "workspace is
 * destroyed when the run ends" — is `destroy()`, and it is the caller's job to
 * call it even when the run failed.
 */
export interface ExecutionSession {
   /** Stable for the life of the session; the driver's handle for the workspace. */
   readonly id: string;

   /** Runs to completion and buffers. Use for short commands whose output is small. */
   exec(command: string, options?: ExecOptions): Promise<ExecResult>;

   /**
    * Runs and yields output as it happens.
    *
    * This is what a live run log is made of, and it is the preferred path:
    * a buffered `exec` of a ten-minute test suite tells the reader nothing
    * until it is over.
    */
   stream(command: string, options?: ExecOptions): AsyncIterable<ExecEvent>;

   writeFile(path: string, content: string): Promise<void>;
   readFile(path: string): Promise<string>;

   /** Kills whatever is running. The session survives; `destroy` ends it. */
   stop(): Promise<void>;

   /** Tears the workspace down. Idempotent — a second call is not an error. */
   destroy(): Promise<void>;
}

export interface ExecutionDriver {
   /** Named in logs and in the run ledger, so an operator can tell which ran. */
   readonly name: string;
   createSession(input: CreateSessionInput): Promise<ExecutionSession>;
   /** Reachability, for readiness. Throws when the substrate cannot be reached. */
   health(): Promise<void>;
}

/**
 * The substrate is not configured, or cannot be reached.
 *
 * Distinct from a failing command on purpose: a run that could not start is
 * not a run that failed, and admission should refuse it rather than record an
 * agent failure that never happened.
 */
export class ExecutionUnavailable extends Error {
   override readonly name = 'ExecutionUnavailable';
   constructor(message: string, options?: { cause?: unknown }) {
      super(message, options);
   }
}

/** The substrate was reached and refused, or broke mid-command. */
export class ExecutionFailed extends Error {
   override readonly name = 'ExecutionFailed';
   constructor(message: string, options?: { cause?: unknown }) {
      super(message, options);
   }
}

/**
 * A driver for a deployment that has not configured execution.
 *
 * Every call throws `ExecutionUnavailable`. This exists so the composition
 * root always has a driver and the call sites have one failure mode, rather
 * than a `null` that every caller has to remember to check — the check that
 * gets forgotten is the one that turns into a 500.
 */
export function unconfiguredDriver(reason: string): ExecutionDriver {
   return {
      name: 'unconfigured',
      createSession() {
         return Promise.reject(new ExecutionUnavailable(reason));
      },
      health() {
         return Promise.reject(new ExecutionUnavailable(reason));
      },
   };
}
