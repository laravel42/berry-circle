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
