import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OPENFANG_BASE_URL: z.string().url().default("http://localhost:4200"),
  OPENFANG_API_KEY: z.string().optional(),
  // Berry-owned Postgres. Optional so the app boots (and `bun test` runs) with no
  // database; request paths that need it fail fast via `getDb()` (src/db/client.ts).
  DATABASE_URL: z.string().url().optional(),
  // Lifetime of a login session before its token expires. 720h = 30 days.
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),
  // Opt-in for the insecure, credential-less "log in by known email" path. Off by
  // default and NEVER honored under NODE_ENV=production (see passwordlessLoginAllowed),
  // so the no-credentials mode can never reach a production deploy silently. `z.coerce
  // .boolean()` is intentionally avoided — it treats the string "false" as truthy.
  AUTH_ALLOW_PASSWORDLESS_LOGIN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration for: ${fields}`);
  }
  return parsed.data;
}

export const config = loadConfig();

/**
 * Whether the credential-less "log in by known email" path may be used.
 * Requires the explicit opt-in AND a non-production environment: the flag is
 * hard-ignored under `NODE_ENV=production` so the insecure mode cannot ship.
 */
export function passwordlessLoginAllowed(cfg: Config = config): boolean {
  return cfg.AUTH_ALLOW_PASSWORDLESS_LOGIN && cfg.NODE_ENV !== "production";
}
