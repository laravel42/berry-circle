import { z } from 'zod';
import { apiFetch } from './api';

/**
 * What server the browser is talking to.
 *
 * `/api/v1/config` is the build's own description — capabilities, and now the
 * version — so the help menu can name it. Useful in exactly the moment it is
 * needed: someone reporting a problem, who should not have to find a terminal
 * to answer "which version?".
 */

const serverInfoSchema = z.object({
   // Defaulted rather than required: an older server answers without it, and
   // an unnamed version is a missing label, not a broken page.
   version: z.string().nullish().default(null),
});

export type ServerInfo = z.infer<typeof serverInfoSchema>;

export async function loadServerInfo(): Promise<ServerInfo> {
   try {
      const json: unknown = await apiFetch('/api/v1/config');
      const parsed = serverInfoSchema.safeParse(json);
      return parsed.success ? parsed.data : { version: null };
   } catch {
      return { version: null };
   }
}
