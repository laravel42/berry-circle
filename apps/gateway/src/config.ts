import { z } from "zod";

// `z.coerce.boolean()` is unusable for env flags: it delegates to `Boolean(str)`,
// so the string "false" coerces to `true`. Parse the common truthy spellings by hand.
const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
    );

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OPENFANG_BASE_URL: z.string().url().default("http://localhost:4200"),
  OPENFANG_API_KEY: z.string().optional(),
  // Observability (Pino logging + OpenTelemetry metrics).
  SERVICE_NAME: z.string().default("berry-gateway"),
  SERVICE_VERSION: z.string().default(process.env.npm_package_version ?? "0.1.0"),
  METRICS_ENABLED: boolFromEnv(true),
  METRICS_PATH: z.string().startsWith("/").default("/metrics"),
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
