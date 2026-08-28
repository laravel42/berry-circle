import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { Demultiplexer, type Frame } from './demux.ts';

/**
 * The Docker Engine API, over its unix socket.
 *
 * Written directly rather than through a client library: the surface Berry
 * needs is seven calls, and a dependency that wraps the whole daemon API is
 * more attack surface and more to audit than the thing it replaces. The one
 * genuinely fiddly part — the multiplexed exec stream — lives in `demux.ts`
 * and is tested on its own.
 */

/** Minimum the daemon must speak. Below this, `/containers/create` is rejected. */
const API_VERSION = 'v1.44';

export interface DockerOptions {
   socketPath: string;
   /** Bounds a single API call. The exec stream is exempt: it lasts as long as the command. */
   requestTimeoutMs?: number;
}

export interface CreateContainerInput {
   image: string;
   name: string;
   cwd: string;
   env: Record<string, string>;
   memoryBytes: number;
   nanoCpus: number;
   pidsLimit: number;
   networkMode: string;
}

export interface ExecInput {
   containerId: string;
   command: string;
   cwd?: string;
   env?: Record<string, string>;
   /** Absent leaves the command unbounded, which only the caller may choose. */
   timeoutMs?: number;
}

export class DockerError extends Error {
   override readonly name = 'DockerError';
   readonly status: number;
   constructor(message: string, status: number) {
      super(message);
      this.status = status;
   }
}

export class Docker {
   readonly #socketPath: string;
   readonly #timeoutMs: number;

   constructor(options: DockerOptions) {
      this.#socketPath = options.socketPath;
      this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
   }

   async ping(): Promise<void> {
      // `/_ping` answers `OK` as plain text, not JSON — draining the body is
      // the whole check, and parsing it is not.
      await this.#drain('GET', '/_ping');
   }

   /**
    * Ensures the image is present.
    *
    * Pulled here rather than left to the first container create, because the
    * daemon's error for a missing image is opaque and would surface as a run
    * that failed for no visible reason.
    */
   async ensureImage(image: string): Promise<void> {
      try {
         await this.#json('GET', `/images/${encodeURIComponent(image)}/json`);
         return;
      } catch (error) {
         if (!(error instanceof DockerError) || error.status !== 404) throw error;
      }
      // A pull streams progress and can take minutes on a cold host.
      await this.#drain('POST', `/images/create?fromImage=${encodeURIComponent(image)}`, {
         timeoutMs: 10 * 60_000,
      });
   }

   async createContainer(input: CreateContainerInput): Promise<string> {
      const body = {
         Image: input.image,
         // Something that stays up without burning a core: the container is a
         // place to exec into, not a process in its own right.
         Cmd: ['tail', '-f', '/dev/null'],
         WorkingDir: input.cwd,
         Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
         Labels: { 'berry.run': input.name },
         HostConfig: {
            Memory: input.memoryBytes,
            NanoCpus: input.nanoCpus,
            PidsLimit: input.pidsLimit,
            NetworkMode: input.networkMode,
            // An agent's commands do not need to gain privileges, and a run
            // that tries is a run doing something it was not asked to.
            SecurityOpt: ['no-new-privileges'],
            CapDrop: ['ALL'],
            AutoRemove: false,
         },
      };
      const created = await this.#json<{ Id: string }>(
         'POST',
         `/containers/create?name=${encodeURIComponent(input.name)}`,
         body
      );
      await this.#drain('POST', `/containers/${created.Id}/start`);
      return created.Id;
   }

   async containerExists(id: string): Promise<boolean> {
      try {
         await this.#json('GET', `/containers/${id}/json`);
         return true;
      } catch (error) {
         if (error instanceof DockerError && error.status === 404) return false;
         throw error;
      }
   }

   async listRunContainers(): Promise<string[]> {
      const filters = encodeURIComponent(JSON.stringify({ label: ['berry.run'] }));
      const containers = await this.#json<Array<{ Id: string }>>(
         'GET',
         `/containers/json?filters=${filters}`
      );
      return containers.map((container) => container.Id);
   }

   /**
    * Runs a command and streams its output.
    *
    * Returns the frames as they arrive and the exit code once the stream
    * drains — in that order, because the exit code is only knowable after the
    * process has ended and asking earlier reports it as still running.
    */
   async *execStream(input: ExecInput): AsyncGenerator<Frame | { exitCode: number }> {
      const created = await this.#json<{ Id: string }>(
         'POST',
         `/containers/${input.containerId}/exec`,
         {
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            // `timeout` rather than tearing down the stream from this side:
            // the container kills its own process, so a bounded command
            // actually stops instead of being abandoned still running. Exit
            // 124 is what `timeout` reports, and a non-zero code is already
            // read as a failure everywhere above.
            //
            // Passed as argv, so the command needs no second round of shell
            // quoting to survive being wrapped.
            Cmd: timeoutArgv(input.timeoutMs, input.command),
            ...(input.cwd ? { WorkingDir: input.cwd } : {}),
            ...(input.env
               ? { Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`) }
               : {}),
         }
      );

      const response = await this.#send('POST', `/exec/${created.Id}/start`, {
         body: { Detach: false, Tty: false },
         // No ceiling: a test suite is allowed to take as long as the caller's
         // own timeout permits, and this stream is how we learn it is alive.
         timeoutMs: 0,
      });

      const demux = new Demultiplexer();
      for await (const chunk of response) {
         for (const frame of demux.push(chunk as Buffer)) yield frame;
      }
      for (const frame of demux.end()) yield frame;

      const info = await this.#json<{ ExitCode: number | null; Running: boolean }>(
         'GET',
         `/exec/${created.Id}/json`
      );
      // A finished exec always has a code. Null means the daemon still thinks
      // it is running, which after a drained stream is a daemon problem, not a
      // success.
      if (info.ExitCode === null) {
         throw new DockerError('exec stream ended but the daemon reports no exit code', 500);
      }
      yield { exitCode: info.ExitCode };
   }

   /** Writes one file, as a tar stream — the only way in through the Engine API. */
   async putFile(containerId: string, path: string, content: string): Promise<void> {
      const { directory, name } = splitPath(path);
      const archive = tarOf(name, Buffer.from(content, 'utf8'));
      await this.#drain(
         'PUT',
         `/containers/${containerId}/archive?path=${encodeURIComponent(directory)}`,
         { raw: archive, contentType: 'application/x-tar' }
      );
   }

   async getFile(containerId: string, path: string): Promise<string> {
      const response = await this.#send(
         'GET',
         `/containers/${containerId}/archive?path=${encodeURIComponent(path)}`,
         {}
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(chunk as Buffer);
      return untarSingle(Buffer.concat(chunks)).toString('utf8');
   }

   /** SIGKILL. Used for stop, so a wedged command actually stops. */
   async kill(containerId: string): Promise<void> {
      try {
         await this.#drain('POST', `/containers/${containerId}/kill`);
      } catch (error) {
         // 409 is "not running", which is the state kill was asking for.
         if (error instanceof DockerError && (error.status === 409 || error.status === 404)) return;
         throw error;
      }
   }

   async remove(containerId: string): Promise<void> {
      try {
         await this.#drain('DELETE', `/containers/${containerId}?force=true&v=true`);
      } catch (error) {
         if (error instanceof DockerError && error.status === 404) return;
         throw error;
      }
   }

   // ---------------------------------------------------------------- transport

   async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await this.#send(method, path, body === undefined ? {} : { body });
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return undefined as T;
      try {
         return JSON.parse(text) as T;
      } catch (cause) {
         throw new Error(`docker returned a non-JSON body for ${path}`, { cause });
      }
   }

   /** Sends and discards the body, for calls whose answer is the status code. */
   async #drain(
      method: string,
      path: string,
      options: SendOptions = {}
   ): Promise<void> {
      const response = await this.#send(method, path, options);
      for await (const _chunk of response) void _chunk;
   }

   #send(method: string, path: string, options: SendOptions): Promise<Readable> {
      const payload =
         options.raw ?? (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8'));
      const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

      return new Promise((resolve, reject) => {
         const request = httpRequest(
            {
               socketPath: this.#socketPath,
               path: `/${API_VERSION}${path}`,
               method,
               headers: {
                  host: 'localhost',
                  ...(payload
                     ? {
                          'content-type': options.contentType ?? 'application/json',
                          'content-length': String(payload.length),
                       }
                     : {}),
               },
            },
            (response: IncomingMessage) => {
               const status = response.statusCode ?? 0;
               if (status >= 400) {
                  const chunks: Buffer[] = [];
                  response.on('data', (chunk: Buffer) => chunks.push(chunk));
                  response.on('end', () => {
                     const text = Buffer.concat(chunks).toString('utf8').slice(0, 300);
                     reject(new DockerError(`docker ${method} ${path}: ${status} ${text}`, status));
                  });
                  return;
               }
               resolve(response);
            }
         );

         if (timeoutMs > 0) {
            request.setTimeout(timeoutMs, () => {
               request.destroy(new Error(`docker ${method} ${path} timed out after ${timeoutMs}ms`));
            });
         }
         request.on('error', (error) => reject(error));
         if (payload) request.write(payload);
         request.end();
      });
   }
}

interface SendOptions {
   body?: unknown;
   raw?: Buffer;
   contentType?: string;
   /** Zero disables the ceiling. Used only for the exec stream. */
   timeoutMs?: number;
}

/**
 * The command, wrapped in a timeout when one was asked for.
 *
 * Seconds because that is what `timeout` takes; anything under a second is
 * rounded up to one, since a sub-second ceiling on a real command is a
 * configuration mistake rather than an intention.
 */
function timeoutArgv(timeoutMs: number | undefined, command: string): string[] {
   if (timeoutMs === undefined || timeoutMs <= 0) return ['sh', '-c', command];
   const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
   return ['timeout', String(seconds), 'sh', '-c', command];
}

function splitPath(path: string): { directory: string; name: string } {
   const index = path.lastIndexOf('/');
   if (index <= 0) return { directory: '.', name: path.replace(/^\//, '') };
   return { directory: path.slice(0, index), name: path.slice(index + 1) };
}

/**
 * A one-file tar archive.
 *
 * Hand-built rather than pulled in as a dependency: the format is a 512-byte
 * header and padded content, and Berry writes exactly one file at a time.
 */
export function tarOf(name: string, content: Buffer): Buffer {
   const header = Buffer.alloc(512);
   header.write(name.slice(0, 99), 0, 'utf8'); // name
   header.write('0000644\0', 100, 'utf8'); // mode
   header.write('0000000\0', 108, 'utf8'); // uid
   header.write('0000000\0', 116, 'utf8'); // gid
   header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8'); // size
   header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'utf8');
   header.write('0', 156, 'utf8'); // type: regular file
   header.write('ustar\0', 257, 'utf8');
   header.write('00', 263, 'utf8');

   // The checksum is computed with its own field read as spaces, then written
   // back into it. Getting this wrong makes tar reject the archive silently.
   header.fill(' ', 148, 156);
   let sum = 0;
   for (const byte of header) sum += byte;
   header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');

   const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
   content.copy(padded);
   // Two zero blocks terminate the archive.
   return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

/** Reads the first regular file out of a tar archive. */
export function untarSingle(archive: Buffer): Buffer {
   let offset = 0;
   while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      if (name === '') break;
      const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
      const type = header.subarray(156, 157).toString('utf8');
      const start = offset + 512;
      if (type === '0' || type === '\0') return archive.subarray(start, start + size);
      offset = start + Math.ceil(size / 512) * 512;
   }
   throw new Error('the archive contained no file');
}
