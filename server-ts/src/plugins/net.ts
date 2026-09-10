import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PluginUnreachable } from './errors.ts';

/**
 * Every outbound request to a plugin goes through here. A plugin's base URL
 * is admin-supplied, so without this Berry would fetch any address it is
 * told to — cloud metadata endpoints and the database included.
 *
 * Checked on the resolved addresses, with redirects refused. A DNS answer
 * that changes between check and connect is a residual risk; it is narrowed,
 * not closed, by the short timeout.
 */

export interface PluginRequest {
   method: 'GET' | 'POST';
   headers?: Record<string, string>;
   body?: string;
   timeoutMs: number;
   maxBytes: number;
}

export interface PluginNetwork {
   request(url: string, init: PluginRequest): Promise<{ status: number; body: string }>;
}

export interface NetworkOptions {
   /** Development and tests only: allows http and private addresses. */
   allowPrivate: boolean;
   resolve?: (host: string) => Promise<string[]>;
   fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
}

/**
 * The IPv4 address an IPv6 address carries, when it is one of the forms that
 * route to IPv4: mapped (::ffff:0:0/96), compatible (::/96), NAT64
 * (64:ff9b::/96) or 6to4 (2002::/16). Handles both the dotted and the hex
 * spelling, because WHATWG URL parsing rewrites `[::ffff:10.0.0.1]` to
 * `[::ffff:a00:1]`.
 */
function embeddedIPv4(address: string): string | null {
   const groups = expandIPv6(address);
   if (!groups) return null;
   const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
   const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
   const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
   if (zeroPrefix && (g5 === 0xffff || g5 === 0) && !(g5 === 0 && g6 === 0)) return quad(g6, g7);
   if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return quad(g6, g7);
   if (g0 === 0x2002) return quad(g1, g2);
   return null;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function expandIPv6(address: string): number[] | null {
   if (isIP(address) !== 6) return null;
   let text = address.toLowerCase();
   const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
   if (dotted) {
      const [a = 0, b = 0, c = 0, d = 0] = (dotted[1] ?? '').split('.').map(Number);
      text = text.slice(0, -(dotted[1] ?? '').length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
   }
   const [head = '', tail] = text.split('::');
   const left = head === '' ? [] : head.split(':');
   const right = tail === undefined || tail === '' ? [] : tail.split(':');
   const missing = 8 - left.length - right.length;
   const all = tail === undefined ? left : [...left, ...Array.from({ length: missing }, () => '0'), ...right];
   return all.length === 8 ? all.map((group) => Number.parseInt(group, 16)) : null;
}

export function isPrivateAddress(address: string): boolean {
   const embedded = embeddedIPv4(address);
   if (embedded) return isPrivateAddress(embedded);
   if (isIP(address) === 4) {
      const [a = 0, b = 0] = address.split('.').map(Number);
      return (
         a === 0 ||
         a === 10 ||
         a === 127 ||
         a >= 224 ||
         (a === 100 && b >= 64 && b <= 127) ||
         (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) ||
         (a === 198 && (b === 18 || b === 19))
      );
   }
   if (isIP(address) === 6) {
      const [first = 0] = expandIPv6(address) ?? [0];
      const lower = address.toLowerCase();
      return (
         lower === '::1' ||
         lower === '::' ||
         (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
         (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
         (first & 0xff00) === 0xff00 // multicast ff00::/8
      );
   }
   // Not an address at all: refuse rather than guess.
   return true;
}

const defaultResolve = async (host: string): Promise<string[]> =>
   (await lookup(host, { all: true })).map((entry) => entry.address);

export function createPluginNetwork(options: NetworkOptions): PluginNetwork {
   const resolve = options.resolve ?? defaultResolve;
   const fetchImpl = options.fetchImpl ?? ((url: URL, init: RequestInit) => fetch(url, init));

   return {
      async request(url, init) {
         let parsed: URL;
         try {
            parsed = new URL(url);
         } catch {
            throw new PluginUnreachable('plugin URL is not valid');
         }
         if (!options.allowPrivate) {
            if (parsed.protocol !== 'https:') throw new PluginUnreachable('plugin endpoints must use https');
            const host = parsed.hostname.replace(/^\[|\]$/g, '');
            let addresses: string[];
            try {
               addresses = isIP(host) ? [host] : await resolve(host);
            } catch (cause) {
               throw new PluginUnreachable('plugin host could not be resolved', { cause });
            }
            if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
               throw new PluginUnreachable('plugin endpoint resolves to a private address');
            }
         } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new PluginUnreachable('plugin endpoints must use http(s)');
         }

         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), init.timeoutMs);
         try {
            const response = await fetchImpl(parsed, {
               method: init.method,
               redirect: 'manual',
               signal: controller.signal,
               ...(init.headers ? { headers: init.headers } : {}),
               ...(init.body !== undefined ? { body: init.body } : {}),
            });
            if (response.status >= 300 && response.status < 400) {
               throw new PluginUnreachable('plugin endpoint redirected');
            }
            return { status: response.status, body: await readLimited(response, init.maxBytes) };
         } catch (error) {
            if (error instanceof PluginUnreachable) throw error;
            const timedOut = error instanceof Error && error.name === 'AbortError';
            throw new PluginUnreachable(
               timedOut ? 'plugin endpoint timed out' : 'plugin endpoint could not be reached',
               { cause: error }
            );
         } finally {
            clearTimeout(timer);
         }
      },
   };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
   if (!response.body) return '';
   const reader = response.body.getReader();
   const chunks: Uint8Array[] = [];
   let total = 0;
   for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
         await reader.cancel();
         throw new PluginUnreachable('plugin response is too large');
      }
      chunks.push(value);
   }
   return Buffer.concat(chunks).toString('utf8');
}
