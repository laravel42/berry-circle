import type { ExecutionSession } from './driver.ts';
import { ExecutionUnavailable } from './driver.ts';
import { shellQuote } from '../agents/checkout.ts';

/**
 * Bytes in and out of a workspace, over the command channel.
 *
 * A session's `writeFile` and `readFile` carry text: one is a heredoc, the
 * other is `cat` into a string, and an MP4 through either comes out the far
 * side re-encoded as UTF-8 and unplayable. Rather than teach three drivers a
 * binary file API, the bytes go as base64 through `exec`, which every driver
 * already has and every sandbox already decodes. Chunked, because a command
 * line is the payload of one request and a clip is bigger than one of those
 * should be.
 */

/**
 * Raw bytes per write command.
 *
 * Base64 grows it by a third, and the AgentCore driver wraps the whole
 * script in base64 again, so 24 KB of file is about 44 KB of command —
 * under the 64 KB that InvokeAgentRuntimeCommand refuses at (measured: 32 KB
 * raw passed, 64 KB was rejected on `body.command` length). A clip goes in
 * about a hundred commands; slow, but it arrives.
 */
const PUT_CHUNK = 24 * 1024;
const GET_CHUNK = 1024 * 1024;

export async function putBytes(session: ExecutionSession, path: string, bytes: Uint8Array): Promise<void> {
   const target = shellQuote(path);
   const prelude = `mkdir -p "$(dirname ${target})"`;
   if (bytes.byteLength === 0) {
      await run(session, `${prelude} && : > ${target}`, `write ${path}`);
      return;
   }
   for (let offset = 0; offset < bytes.byteLength; offset += PUT_CHUNK) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + PUT_CHUNK)).toString('base64');
      // `>` on the first chunk so a stale file at the path is replaced, not
      // appended to; `>>` after that.
      const redirect = offset === 0 ? '>' : '>>';
      await run(session, `${prelude} && printf '%s' '${chunk}' | base64 -d ${redirect} ${target}`, `write ${path}`);
   }
}

export class FileTooLarge extends Error {
   override readonly name = 'FileTooLarge';
   readonly path: string;
   readonly sizeBytes: number;
   readonly maxBytes: number;
   constructor(path: string, sizeBytes: number, maxBytes: number) {
      super(`${path} is ${sizeBytes} bytes; at most ${maxBytes} can be collected`);
      this.path = path;
      this.sizeBytes = sizeBytes;
      this.maxBytes = maxBytes;
   }
}

/**
 * The file's bytes, or null when there is no file at the path.
 *
 * Sized first so a file over the cap is refused before any of it is moved,
 * and read in chunks that are each one command's output.
 */
export async function getBytes(
   session: ExecutionSession,
   path: string,
   options: { maxBytes: number; cwd?: string }
): Promise<Uint8Array | null> {
   const target = shellQuote(path);
   const exec = (command: string) =>
      session.exec(command, options.cwd === undefined ? {} : { cwd: options.cwd });
   // `wc -c` on stdin is the size everywhere — coreutils, busybox and BSD —
   // where `stat` wants a different flag on each.
   const sized = await exec(`test -f ${target} && wc -c < ${target}`);
   if (sized.exitCode !== 0) return null;
   const size = Number.parseInt(sized.stdout.trim(), 10);
   if (!Number.isFinite(size) || size < 0) {
      throw new ExecutionUnavailable(`could not size ${path}: ${sized.stdout.slice(0, 80)}`);
   }
   if (size > options.maxBytes) throw new FileTooLarge(path, size, options.maxBytes);

   const parts: Buffer[] = [];
   for (let offset = 0; offset < size; offset += GET_CHUNK) {
      // tail's offset is 1-based and counts the byte it starts on.
      const result = await exec(`tail -c +${offset + 1} ${target} | head -c ${GET_CHUNK} | base64 | tr -d '\\n'`);
      if (result.exitCode !== 0) {
         throw new ExecutionUnavailable(`could not read ${path}: ${result.stderr.slice(0, 200)}`);
      }
      parts.push(Buffer.from(result.stdout.trim(), 'base64'));
   }
   const bytes = Buffer.concat(parts);
   if (bytes.byteLength !== size) {
      // A file that changed under the read, or output that was cut: either
      // way not the file, and saying so beats saving a truncated one.
      throw new ExecutionUnavailable(`read ${bytes.byteLength} of ${size} bytes from ${path}`);
   }
   return bytes;
}

async function run(session: ExecutionSession, command: string, what: string): Promise<void> {
   const result = await session.exec(command);
   if (result.exitCode !== 0) {
      throw new ExecutionUnavailable(`could not ${what}: ${result.stderr.slice(0, 200)}`);
   }
}
