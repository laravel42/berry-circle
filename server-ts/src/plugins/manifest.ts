import { z } from 'zod';
import { API_SCOPES } from '../public-api/scopes.ts';
import { InvalidPluginInput, zodFields, type PluginFieldError } from './errors.ts';

/**
 * The plugin package: a manifest describing what the plugin asks for, plus a
 * few text files shown in the install preview. Berry never serves the files
 * as pages — surfaces are the plugin's own https URLs, loaded in an iframe.
 */

const KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHORT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FILE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const pathSchema = z
   .string()
   .regex(/^\/[A-Za-z0-9._~/-]{0,200}$/, 'Path must start with / and use URL-safe characters.')
   .refine((path) => !path.split('/').includes('..'), 'Path must not contain "..".');

const baseUrlSchema = z
   .string()
   .max(500)
   .refine((value) => {
      try {
         const url = new URL(value);
         return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === ''
         );
      } catch {
         return false;
      }
   }, 'Base URL must be an http(s) URL without credentials, query or fragment.');

const configFieldSchema = z
   .object({
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
      label: z.string().trim().min(1).max(80),
      type: z.enum(['string', 'number', 'boolean']),
      required: z.boolean().default(false),
   })
   .strict();

const hookSchema = z.discriminatedUnion('trigger', [
   z
      .object({
         key: z.string().regex(SHORT_KEY),
         trigger: z.literal('event'),
         events: z.array(z.string().regex(/^[a-z]+(\.[a-z_]+)+$/)).min(1).max(20),
         path: pathSchema,
      })
      .strict(),
   z
      .object({
         key: z.string().regex(SHORT_KEY),
         trigger: z.literal('schedule'),
         everyMinutes: z.number().int().min(5).max(10080),
         path: pathSchema,
      })
      .strict(),
]);

export const pluginManifestSchema = z
   .object({
      schemaVersion: z.literal(1),
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(80),
      version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
      description: z.string().max(500).default(''),
      baseUrl: baseUrlSchema,
      scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length).default([]),
      config: z.array(configFieldSchema).max(50).default([]),
      secrets: z
         .array(
            z
               .object({
                  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
                  description: z.string().max(200).default(''),
               })
               .strict()
         )
         .max(20)
         .default([]),
      hooks: z.array(hookSchema).max(20).default([]),
      surfaces: z
         .array(
            z
               .object({
                  key: z.string().regex(SHORT_KEY),
                  title: z.string().trim().min(1).max(60),
                  path: pathSchema,
               })
               .strict()
         )
         .max(10)
         .default([]),
      mcp: z
         .object({
            path: pathSchema,
            tools: z
               .array(
                  z
                     .object({
                        name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
                        description: z.string().max(500).default(''),
                     })
                     .strict()
               )
               .min(1)
               .max(50),
         })
         .strict()
         .optional(),
   })
   .strict()
   .superRefine((manifest, ctx) => {
      const unique = (values: string[], path: (index: number) => (string | number)[]) => {
         const seen = new Set<string>();
         values.forEach((value, index) => {
            if (seen.has(value)) ctx.addIssue({ code: 'custom', message: 'Must be unique.', path: path(index) });
            seen.add(value);
         });
      };
      unique(manifest.config.map((f) => f.key), (i) => ['config', i, 'key']);
      unique(manifest.secrets.map((s) => s.name), (i) => ['secrets', i, 'name']);
      unique(manifest.hooks.map((h) => h.key), (i) => ['hooks', i, 'key']);
      unique(manifest.surfaces.map((s) => s.key), (i) => ['surfaces', i, 'key']);
      unique((manifest.mcp?.tools ?? []).map((t) => t.name), (i) => ['mcp', 'tools', i, 'name']);
   });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginPackageSchema = z
   .object({
      manifest: pluginManifestSchema,
      files: z
         .array(
            z
               .object({
                  path: z
                     .string()
                     .max(200)
                     .regex(FILE_PATH)
                     .refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), 'Invalid path.'),
                  content: z.string().max(262_144),
               })
               .strict()
         )
         .max(50)
         .default([]),
   })
   .strict()
   .superRefine((pkg, ctx) => {
      const total = pkg.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
      if (total > 1_000_000) ctx.addIssue({ code: 'custom', message: 'Files exceed 1 MB in total.', path: ['files'] });
      const seen = new Set<string>();
      pkg.files.forEach((file, index) => {
         if (seen.has(file.path)) ctx.addIssue({ code: 'custom', message: 'Must be unique.', path: ['files', index, 'path'] });
         seen.add(file.path);
      });
   });

export type PluginPackage = z.infer<typeof pluginPackageSchema>;
export type PluginConfigValue = string | number | boolean;
export type PluginConfig = Record<string, PluginConfigValue>;

export function parsePackage(value: unknown): PluginPackage {
   const parsed = pluginPackageSchema.safeParse(value);
   if (!parsed.success) throw new InvalidPluginInput(zodFields(parsed.error));
   return parsed.data;
}

/** Config must name only declared keys, with the declared type; required keys must be present. */
export function validateConfig(manifest: PluginManifest, value: unknown): PluginConfig {
   if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidPluginInput([{ path: '/config', message: 'Config must be an object.' }]);
   }
   const input = value as Record<string, unknown>;
   const fields: PluginFieldError[] = [];
   const config: PluginConfig = {};
   const declared = new Map(manifest.config.map((field) => [field.key, field]));
   for (const key of Object.keys(input)) {
      if (!declared.has(key)) fields.push({ path: `/config/${key}`, message: 'The plugin does not declare this setting.' });
   }
   for (const field of manifest.config) {
      const entry = input[field.key];
      if (entry === undefined || entry === null || entry === '') {
         if (field.required) fields.push({ path: `/config/${field.key}`, message: `${field.label} is required.` });
         continue;
      }
      const typeOk =
         (field.type === 'string' && typeof entry === 'string' && entry.length <= 2000) ||
         (field.type === 'number' && typeof entry === 'number' && Number.isFinite(entry)) ||
         (field.type === 'boolean' && typeof entry === 'boolean');
      if (!typeOk) {
         fields.push({ path: `/config/${field.key}`, message: `${field.label} must be a ${field.type}.` });
         continue;
      }
      config[field.key] = entry as PluginConfigValue;
   }
   if (fields.length > 0) throw new InvalidPluginInput(fields);
   return config;
}

export interface PluginPreview {
   key: string;
   name: string;
   version: string;
   description: string;
   baseUrl: string;
   scopes: string[];
   config: PluginManifest['config'];
   secrets: PluginManifest['secrets'];
   events: string[];
   schedules: { key: string; everyMinutes: number }[];
   surfaces: { key: string; title: string }[];
   mcpTools: string[];
   files: { path: string; size: number }[];
}

export function describePackage(pkg: PluginPackage): PluginPreview {
   const { manifest } = pkg;
   const events = new Set<string>();
   const schedules: { key: string; everyMinutes: number }[] = [];
   for (const hook of manifest.hooks) {
      if (hook.trigger === 'event') for (const event of hook.events) events.add(event);
      else schedules.push({ key: hook.key, everyMinutes: hook.everyMinutes });
   }
   return {
      key: manifest.key,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      baseUrl: manifest.baseUrl,
      scopes: [...manifest.scopes],
      config: manifest.config,
      secrets: manifest.secrets,
      events: [...events].sort(),
      schedules,
      surfaces: manifest.surfaces.map((s) => ({ key: s.key, title: s.title })),
      mcpTools: (manifest.mcp?.tools ?? []).map((t) => t.name),
      files: pkg.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8') })),
   };
}
