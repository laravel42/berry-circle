import {
   BedrockAgentCoreClient,
   InvokeAgentRuntimeCommandCommand,
   StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
   ExecutionUnavailable,
   type CreateSessionInput,
   type ExecEvent,
   type ExecOptions,
   type ExecResult,
   type ExecutionDriver,
   type ExecutionSession,
} from './driver.ts';
import { runtimeSessionIdFor } from '../runtime/session-id.ts';

/**
 * Amazon Bedrock AgentCore Runtimes as an execution substrate.
 *
 * The sibling of the Code Interpreter driver (`agentcore.ts`): both implement
 * the same `ExecutionSession` seam so nothing that reads a run can tell which
 * ran an agent's commands. They differ in the AWS surface they call. Code
 * Interpreter runs shell in a managed interpreter session; this invokes a
 * *deployed AgentCore Runtime* — an operator's own container image, addressed
 * by ARN — through `InvokeAgentRuntimeCommand`, which "executes a command in a
 * runtime session container and streams the output back."
 *
 * Why an operator would choose it over Code Interpreter: the runtime is their
 * image with their network rules, so a run that must clone from github.com has
 * the egress the managed interpreter may lack, and the sandbox carries
 * whatever toolchain the image was built with rather than the interpreter's
 * fixed one.
 *
 * The trade is the same shape as Code Interpreter's: a network round trip per
 * command, and no `writeFile`/`readFile` API — those go through the shell, the
 * one command channel the runtime exposes.
 */

/** Runtime session container idle ceiling is AWS-managed; a stopped run is torn down explicitly. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The invoke envelope AWS's own examples set explicitly.
 *
 * `accept` is the load-bearing one: the response is an event stream, and asking
 * for it by name is what the documented call does rather than relying on an SDK
 * default. `qualifier` names the agent alias — `DEFAULT` when a deployment has
 * not pinned a version, which is what AgentCore resolves to anyway; sending it
 * makes the call the same shape as the reference example.
 */
const CONTENT_TYPE = 'application/json';
const ACCEPT_EVENT_STREAM = 'application/vnd.amazon.eventstream';
const DEFAULT_QUALIFIER = 'DEFAULT';

export interface AgentCoreRuntimeDriverOptions {
   region: string;
   /** The deployed AgentCore Runtime to invoke, addressed by ARN. */
   runtimeArn: string;
   /** An agent alias/version. Absent means AgentCore's DEFAULT. */
   qualifier?: string;
   /**
    * Explicit AWS credentials. Absent means the default chain, which is wrong
    * in the Compose stack: `AWS_ACCESS_KEY_ID` there is MinIO's, so a client
    * left to find its own credential authenticates to AWS as the object store.
    */
   credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
   client?: BedrockAgentCoreClient;
}

export function agentCoreRuntimeDriver(options: AgentCoreRuntimeDriverOptions): ExecutionDriver {
   const client =
      options.client ??
      new BedrockAgentCoreClient({
         region: options.region,
         ...(options.credentials ? { credentials: options.credentials } : {}),
      });

   return {
      name: 'agentcore-runtime',

      createSession(input: CreateSessionInput): Promise<ExecutionSession> {
         // No explicit start: the runtime session is created on the first
         // invoke that carries its id. Berry's run id is that id, so a retry of
         // the same run reaches the same session rather than a fresh one — the
         // property the Docker and Code Interpreter drivers give by addressing
         // their workspaces the same way.
         return Promise.resolve(
            new AgentCoreRuntimeSession(client, options, runtimeSessionId(`run:${input.runId}`), input)
         );
      },

      async health(): Promise<void> {
         // A no-op command is the only honest reachability check: it exercises
         // the credential, the region and the runtime ARN, and a control-plane
         // listing would exercise none of them. The session it opens is stopped
         // straight after so a health check leaves nothing running.
         const sessionId = runtimeSessionId(`health:${Date.now()}`);
         try {
            const response = await client.send(
               new InvokeAgentRuntimeCommandCommand({
                  agentRuntimeArn: options.runtimeArn,
                  qualifier: options.qualifier ?? DEFAULT_QUALIFIER,
                  runtimeSessionId: sessionId,
                  contentType: CONTENT_TYPE,
                  accept: ACCEPT_EVENT_STREAM,
                  body: { command: shellScript('true') },
               })
            );
            // Drain the stream so the invoke completes rather than leaving a
            // half-read response holding the session open.
            for await (const _ of response.stream ?? []) {
               // no-op
            }
         } catch (cause) {
            throw new ExecutionUnavailable(
               `could not reach AgentCore Runtime: ${message(cause)}`,
               { cause }
            );
         } finally {
            await client
               .send(
                  new StopRuntimeSessionCommand({
                     agentRuntimeArn: options.runtimeArn,
                     qualifier: options.qualifier ?? DEFAULT_QUALIFIER,
                     runtimeSessionId: sessionId,
                  })
               )
               .catch(() => undefined);
         }
      },
   };
}

class AgentCoreRuntimeSession implements ExecutionSession {
   readonly id: string;
   readonly #client: BedrockAgentCoreClient;
   readonly #runtimeArn: string;
   readonly #qualifier: string | undefined;
   readonly #env: Record<string, string>;
   readonly #cwd: string | undefined;
   #destroyed = false;

   constructor(
      client: BedrockAgentCoreClient,
      options: AgentCoreRuntimeDriverOptions,
      runtimeSessionId: string,
      input: CreateSessionInput
   ) {
      this.#client = client;
      this.#runtimeArn = options.runtimeArn;
      this.#qualifier = options.qualifier;
      this.id = runtimeSessionId;
      this.#env = input.env ?? {};
      this.#cwd = input.cwd;
   }

   async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode = 0;
      for await (const event of this.stream(command, options)) {
         if (event.type === 'stdout') stdout.push(event.data);
         else if (event.type === 'stderr') stderr.push(event.data);
         else if (event.type === 'exit') exitCode = event.exitCode;
         else if (event.type === 'error') {
            stderr.push(event.message);
            exitCode = exitCode === 0 ? 1 : exitCode;
         }
      }
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
   }

   async *stream(command: string, options: ExecOptions = {}): AsyncIterable<ExecEvent> {
      if (this.#destroyed) throw new ExecutionUnavailable('this session has been destroyed');
      let seq = 0;
      yield { type: 'start', seq: seq++, command };

      // Per-command directory and environment are applied as shell prefixes
      // rather than parameters, because the runtime command channel takes a
      // command string and nothing else. `export` keeps a secret out of the
      // command Berry records — `command` above is the caller's string, which
      // is what reaches the ledger, not this composed one.
      const prelude = [
         ...(options.cwd ?? this.#cwd ? [`cd ${shellQuote(options.cwd ?? this.#cwd!)}`] : []),
         ...Object.entries({ ...this.#env, ...(options.env ?? {}) }).map(
            ([key, value]) => `export ${key}=${shellQuote(value)}`
         ),
      ];
      const full = [...prelude, command].join('\n');

      const timeout = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

      try {
         const response = await this.#client.send(
            new InvokeAgentRuntimeCommandCommand({
               agentRuntimeArn: this.#runtimeArn,
               qualifier: this.#qualifier ?? DEFAULT_QUALIFIER,
               runtimeSessionId: this.id,
               contentType: CONTENT_TYPE,
               accept: ACCEPT_EVENT_STREAM,
               body: {
                  command: shellScript(full),
                  // AgentCore's timeout is seconds; Berry's is millis.
                  timeout: Math.max(1, Math.round(timeout / 1000)),
               },
            }),
            { ...(options.signal ? { abortSignal: options.signal as never } : {}) }
         );

         let exited = false;
         for await (const item of response.stream ?? []) {
            const error = runtimeStreamError(item);
            if (error) {
               yield { type: 'error', seq: seq++, message: error };
               continue;
            }
            const chunk = item.chunk;
            if (!chunk) continue;
            const delta = chunk.contentDelta;
            if (delta) {
               if (typeof delta.stdout === 'string' && delta.stdout !== '') {
                  yield { type: 'stdout', seq: seq++, data: delta.stdout };
               }
               if (typeof delta.stderr === 'string' && delta.stderr !== '') {
                  yield { type: 'stderr', seq: seq++, data: delta.stderr };
               }
            }
            const stop = chunk.contentStop;
            if (stop) {
               // TIMED_OUT is a substrate outcome, not a command result: the
               // command did not choose its exit code, the ceiling did. It is
               // surfaced as an error event so a reader can tell a slow command
               // that was reaped from one that ran and failed, while the exit
               // event still closes the stream for the command tool.
               if (stop.status === 'TIMED_OUT') {
                  yield {
                     type: 'error',
                     seq: seq++,
                     message: `command timed out after ${Math.round(timeout / 1000)}s`,
                  };
               }
               yield { type: 'exit', seq: seq++, exitCode: stop.exitCode ?? 1 };
               exited = true;
            }
         }

         // A stream that ended without a contentStop is a broken command, not
         // a silent success: closing it with exit 0 would tell the model its
         // build passed when the runtime never said so.
         if (!exited) {
            yield {
               type: 'error',
               seq: seq++,
               message: 'the runtime stream ended before the command reported an exit code',
            };
            yield { type: 'exit', seq: seq++, exitCode: 1 };
         }
      } catch (cause: unknown) {
         // Reported as an event rather than thrown, matching the Code
         // Interpreter driver: a command that could not be sent and one that
         // ran and failed look the same to a reader of the run, and both belong
         // in the stream rather than only in a log.
         yield { type: 'error', seq: seq++, message: message(cause) };
         yield { type: 'exit', seq: seq++, exitCode: 1 };
      }
   }

   async writeFile(path: string, content: string): Promise<void> {
      // Through the shell rather than a file API, so one code path carries the
      // session's directory and environment. The heredoc terminator is chosen
      // to be absent from the content; a naive `EOF` breaks on any file that
      // contains one, which shell scripts routinely do.
      const marker = `BERRY_EOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      // The terminator has to start its own line, but content that already ends
      // in a newline needs no second one — adding it unconditionally appended a
      // blank line to every file written, which a byte-comparison test caught.
      const body = content.endsWith('\n') ? content : `${content}\n`;
      const result = await this.exec(
         `mkdir -p "$(dirname ${shellQuote(path)})" && cat > ${shellQuote(path)} <<'${marker}'\n${body}${marker}`
      );
      if (result.exitCode !== 0) {
         throw new ExecutionUnavailable(`could not write ${path}: ${result.stderr.slice(0, 200)}`);
      }
   }

   async readFile(path: string): Promise<string> {
      const result = await this.exec(`cat ${shellQuote(path)}`);
      if (result.exitCode !== 0) {
         throw new ExecutionUnavailable(`could not read ${path}: ${result.stderr.slice(0, 200)}`);
      }
      return result.stdout;
   }

   async stop(): Promise<void> {
      // AgentCore has no cancel that leaves the session standing, so the
      // closest honest thing is to do nothing: `destroy` ends it, and a caller
      // that wanted the session afterwards would be surprised by a stop that
      // silently took it away. Matches the Code Interpreter driver.
   }

   async destroy(): Promise<void> {
      if (this.#destroyed) return;
      this.#destroyed = true;
      await this.#client
         .send(
            new StopRuntimeSessionCommand({
               agentRuntimeArn: this.#runtimeArn,
               qualifier: this.#qualifier ?? DEFAULT_QUALIFIER,
               runtimeSessionId: this.id,
            })
         )
         .catch(() => undefined);
   }
}

/**
 * The message of a typed error variant in the runtime stream, or null.
 *
 * The stream union carries either a `chunk` or one of several exception
 * shapes. Each is surfaced to the run as an `error` event rather than thrown,
 * so a mid-command failure reads the same as a command that ran and failed.
 */
function runtimeStreamError(item: {
   accessDeniedException?: { message?: string | undefined } | undefined;
   internalServerException?: { message?: string | undefined } | undefined;
   resourceNotFoundException?: { message?: string | undefined } | undefined;
   serviceQuotaExceededException?: { message?: string | undefined } | undefined;
   throttlingException?: { message?: string | undefined } | undefined;
   validationException?: { message?: string | undefined } | undefined;
   runtimeClientError?: { message?: string | undefined } | undefined;
}): string | null {
   const variant =
      item.accessDeniedException ??
      item.internalServerException ??
      item.resourceNotFoundException ??
      item.serviceQuotaExceededException ??
      item.throttlingException ??
      item.validationException ??
      item.runtimeClientError;
   if (!variant) return null;
   return variant.message ?? 'the runtime returned an error';
}

/**
 * The runtime session id for a session key (see `runtime/session-id.ts`).
 *
 * Exported so the invoke transport and this command driver agree on one
 * derivation. The command driver addresses sessions per run (`run:<id>`),
 * because it is only used for health checks now that the loop runs inside the
 * runtime.
 */
export function runtimeSessionId(sessionKey: string): string {
   return runtimeSessionIdFor(sessionKey);
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Wraps a script so AgentCore runs it as a shell script rather than as argv.
 *
 * `body.command` is **not** run through a shell. AgentCore tokenizes the string
 * and execs it, so `echo a && echo b` prints a literal `&&`, `for` is looked up
 * as a binary, and a pipeline sends every word to the first command as
 * arguments. All three were observed against the live service before this
 * wrapper existed.
 *
 * Quoting alone would work — the tokenizer does respect quotes — but Berry
 * sends whatever an agent wrote, and that routinely contains single quotes,
 * double quotes and newlines (the heredoc `writeFile` builds has all three).
 * Base64 sidesteps the tokenizer completely: the payload is only
 * `[A-Za-z0-9+/=]`, so there is nothing left for it to split on or unquote.
 * The script's own exit code survives because it is the last stage of the
 * pipeline, which is what the pipeline reports.
 */
function shellScript(script: string): string {
   const encoded = Buffer.from(script, 'utf8').toString('base64');
   return `/bin/bash -c "echo ${encoded} | base64 -d | /bin/bash"`;
}

/** Single-quoted for POSIX sh, with embedded quotes closed and reopened. */
function shellQuote(value: string): string {
   return `'${value.replaceAll("'", `'\\''`)}'`;
}
