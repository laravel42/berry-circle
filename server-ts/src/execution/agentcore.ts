import {
   BedrockAgentCoreClient,
   InvokeCodeInterpreterCommand,
   StartCodeInterpreterSessionCommand,
   StopCodeInterpreterSessionCommand,
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

/**
 * Amazon Bedrock AgentCore as an execution substrate.
 *
 * Berry already had a substrate seam — `ExecutionSession` — and this
 * implements it rather than replacing the run model. That is the whole reason
 * AgentCore can be added without touching the ledger, the run stream, or the
 * repository work: an agent's commands go somewhere else, and nothing that
 * reads a run can tell.
 *
 * The trade against the Docker driver is worth stating plainly. AgentCore
 * gives session isolation and no containers to operate; it costs a network
 * round trip per command, and a managed Code Interpreter has no route to
 * github.com over the public internet, which a managed interpreter may not
 * have — so a deployment whose agents must clone needs a Code Interpreter of
 * its own with that egress allowed.
 */

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** How long a session may sit idle before AgentCore reclaims it. */
const SESSION_TIMEOUT_SECONDS = 3600;

export interface AgentCoreDriverOptions {
   region: string;
   codeInterpreterId: string;
   client?: BedrockAgentCoreClient;
}

export function agentCoreDriver(options: AgentCoreDriverOptions): ExecutionDriver {
   const client =
      options.client ?? new BedrockAgentCoreClient({ region: options.region });

   return {
      name: 'agentcore',

      async createSession(input: CreateSessionInput): Promise<ExecutionSession> {
         const started = await client
            .send(
               new StartCodeInterpreterSessionCommand({
                  codeInterpreterIdentifier: options.codeInterpreterId,
                  // Berry's run id, so a retry of the same run reaches the same
                  // workspace rather than a fresh one — the property the Docker
                  // driver gives by addressing containers the same way.
                  name: `berry-${input.runId}`,
                  sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
               })
            )
            .catch(unavailable('start a Code Interpreter session'));

         const sessionId = started.sessionId;
         if (!sessionId) {
            throw new ExecutionUnavailable('AgentCore returned no session id');
         }
         return new AgentCoreSession(client, options.codeInterpreterId, sessionId, input);
      },

      async health(): Promise<void> {
         // Starting and stopping a session is the only honest reachability
         // check: the credential, the region and the interpreter id are all
         // exercised, and a listing would exercise none of them.
         const probe = await client
            .send(
               new StartCodeInterpreterSessionCommand({
                  codeInterpreterIdentifier: options.codeInterpreterId,
                  name: 'berry-health',
                  sessionTimeoutSeconds: 60,
               })
            )
            .catch(unavailable('reach AgentCore'));
         if (probe.sessionId) {
            await client
               .send(
                  new StopCodeInterpreterSessionCommand({
                     codeInterpreterIdentifier: options.codeInterpreterId,
                     sessionId: probe.sessionId,
                  })
               )
               .catch(() => undefined);
         }
      },
   };
}

class AgentCoreSession implements ExecutionSession {
   readonly id: string;
   readonly #client: BedrockAgentCoreClient;
   readonly #interpreter: string;
   readonly #env: Record<string, string>;
   readonly #cwd: string | undefined;
   #destroyed = false;

   constructor(
      client: BedrockAgentCoreClient,
      interpreter: string,
      sessionId: string,
      input: CreateSessionInput
   ) {
      this.#client = client;
      this.#interpreter = interpreter;
      this.id = sessionId;
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

      // Per-command environment and directory are applied as shell prefixes
      // rather than passed as parameters, because Code Interpreter's shell tool
      // takes a command and nothing else. `export` keeps a secret out of the
      // command Berry records — `command` above is what reaches the ledger, and
      // it is the caller's string, not this one.
      const prelude = [
         ...(options.cwd ?? this.#cwd ? [`cd ${shellQuote(options.cwd ?? this.#cwd!)}`] : []),
         ...Object.entries({ ...this.#env, ...(options.env ?? {}) }).map(
            ([key, value]) => `export ${key}=${shellQuote(value)}`
         ),
      ];
      const full = [...prelude, command].join('\n');

      try {
         const response = await this.#client.send(
            new InvokeCodeInterpreterCommand({
               codeInterpreterIdentifier: this.#interpreter,
               sessionId: this.id,
               name: 'executeCommand',
               arguments: { command: full },
            }),
            { ...(options.signal ? { abortSignal: options.signal as never } : {}) }
         );

         let failed = false;
         for await (const chunk of response.stream ?? []) {
            const result = chunk.result;
            if (!result) continue;
            if (result.isError) failed = true;
            for (const item of result.content ?? []) {
               const text = typeof item.text === 'string' ? item.text : '';
               if (text === '') continue;
               yield { type: result.isError ? 'stderr' : 'stdout', seq: seq++, data: text };
            }
         }
         yield { type: 'exit', seq: seq++, exitCode: failed ? 1 : 0 };
      } catch (cause: unknown) {
         // Reported as an event rather than thrown: a command that could not be
         // sent and one that ran and failed look the same to a reader of the
         // run, and both belong in the stream rather than only in a log.
         yield {
            type: 'error',
            seq: seq++,
            message: cause instanceof Error ? cause.message : String(cause),
         };
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
      // blank line to every file written.
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
      // silently took it away.
   }

   async destroy(): Promise<void> {
      if (this.#destroyed) return;
      this.#destroyed = true;
      await this.#client
         .send(
            new StopCodeInterpreterSessionCommand({
               codeInterpreterIdentifier: this.#interpreter,
               sessionId: this.id,
            })
         )
         .catch(() => undefined);
   }
}

/** Wraps an AWS failure as the substrate being unreachable, with what was attempted. */
function unavailable(what: string) {
   return (cause: unknown): never => {
      throw new ExecutionUnavailable(
         `could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
   };
}

/** Single-quoted for POSIX sh, with embedded quotes closed and reopened. */
function shellQuote(value: string): string {
   return `'${value.replaceAll("'", `'\\''`)}'`;
}
