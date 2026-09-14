import { z } from 'zod';
import { toRFC3339, type Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Workspace-defined issue fields. The kind decides the value's shape; the value
 * is validated against the definition on every write, because the table only
 * checks that it is jsonb of bounded size.
 */
export const PROPERTY_KINDS = [
   'text',
   'number',
   'boolean',
   'date',
   'url',
   'select',
   'multi_select',
   'person',
   'multi_person',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

const SELECT_KINDS: ReadonlySet<string> = new Set(['select', 'multi_select']);

const optionSchema = z
   .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
      name: z.string().trim().min(1).max(100),
      color: z.string().regex(/^#[0-9a-f]{6}$/),
   })
   .strict();
export type PropertyOption = z.infer<typeof optionSchema>;

const optionsSchema = z
   .array(optionSchema)
   .min(1)
   .max(100)
   .refine((options) => new Set(options.map((option) => option.id)).size === options.length, {
      message: 'Option ids must be unique.',
   });

export const propertyCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(1000).nullable().default(null),
      kind: z.enum(PROPERTY_KINDS),
      options: optionsSchema.optional(),
      icon: z.string().min(1).max(100).nullable().default(null),
      sortOrder: z.number().int().min(0).max(1_000_000_000).default(0),
   })
   .strict()
   .superRefine((value, context) => {
      if (SELECT_KINDS.has(value.kind) && !value.options) {
         context.addIssue({ code: 'custom', path: ['options'], message: 'A select needs at least one option.' });
      }
      if (!SELECT_KINDS.has(value.kind) && value.options) {
         context.addIssue({ code: 'custom', path: ['options'], message: 'Only a select has options.' });
      }
   });
export type PropertyCreate = z.infer<typeof propertyCreateSchema>;

/** The kind is not patchable: stored values were validated against it. */
export const propertyPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      options: optionsSchema.optional(),
      icon: z.string().min(1).max(100).nullable().optional(),
      sortOrder: z.number().int().min(0).max(1_000_000_000).optional(),
      /**
       * `false` restores an archived property; archiving stays the DELETE
       * route's job, so the reversible verb and the destructive-looking one
       * are never the same request.
       */
      archived: z.literal(false).optional(),
   })
   .strict();
export type PropertyPatch = z.infer<typeof propertyPatchSchema>;

export interface PropertyDefinition {
   id: string;
   workspaceId: string;
   name: string;
   description: string | null;
   kind: PropertyKind;
   options: PropertyOption[];
   icon: string | null;
   sortOrder: number;
   createdAt: string;
   updatedAt: string;
   archivedAt: string | null;
}

export class PropertyNameTaken extends Error {
   constructor() {
      super('a property with that name exists');
      this.name = 'PropertyNameTaken';
   }
}

/**
 * The number of properties a workspace can have in use at once.
 *
 * Every active property is a row in the task panel and a column in every
 * picker that offers them, so the cost of one more is paid by everyone on
 * every task, not by the person who added it. Twenty is generous for the
 * vocabulary a team actually maintains, and archiving is free — the bound is
 * on what is in use, not on what has ever existed.
 */
export const MAX_ACTIVE_PROPERTIES = 20;

export class TooManyProperties extends Error {
   constructor() {
      super(`a workspace has at most ${MAX_ACTIVE_PROPERTIES} active properties`);
      this.name = 'TooManyProperties';
   }
}

export class PropertyKindMismatch extends Error {
   constructor() {
      super('only a select property has options');
      this.name = 'PropertyKindMismatch';
   }
}

export class InvalidPropertyValue extends Error {
   readonly issues: Array<{ path: string; message: string }>;
   constructor(issues: Array<{ path: string; message: string }>) {
      super('invalid property value');
      this.name = 'InvalidPropertyValue';
      this.issues = issues;
   }
}

const COLUMNS =
   'id, workspace_id, name, description, kind, config, icon, sort_order, created_at, updated_at, archived_at';

function toDefinition(row: Record<string, unknown>): PropertyDefinition {
   const config = (row.config ?? {}) as { options?: unknown };
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      kind: row.kind as PropertyKind,
      options: Array.isArray(config.options) ? (config.options as PropertyOption[]) : [],
      icon: (row.icon as string | null) ?? null,
      sortOrder: Number(row.sort_order),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
      archivedAt: toRFC3339((row.archived_at as string | null) ?? null),
   };
}

export function serializeProperty(definition: PropertyDefinition): Record<string, unknown> {
   return { ...definition };
}

function mapNameConflict(error: unknown): never {
   if ((error as { code?: string }).code === '23505') throw new PropertyNameTaken();
   throw error;
}

export async function listProperties(
   q: Queryable,
   workspaceId: string,
   includeArchived: boolean
): Promise<PropertyDefinition[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_property_definitions
       WHERE workspace_id = ${workspaceId} AND (${includeArchived} OR archived_at IS NULL)
       ORDER BY sort_order, lower(name), id`;
   return rows.map(toDefinition);
}

export async function getProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string,
   includeArchived = false
): Promise<PropertyDefinition> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_property_definitions
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId}
         AND (${includeArchived}::boolean OR archived_at IS NULL)`;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

export async function createProperty(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: PropertyCreate
): Promise<PropertyDefinition> {
   const [counted] = await q`
      SELECT count(*)::int AS active FROM issue_property_definitions
       WHERE workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (Number(counted?.active ?? 0) >= MAX_ACTIVE_PROPERTIES) throw new TooManyProperties();

   const config = input.options ? { options: input.options } : {};
   const rows = await q`
      INSERT INTO issue_property_definitions
         (workspace_id, name, description, kind, config, icon, sort_order, created_by)
      VALUES (${workspaceId}, ${input.name}, ${input.description}, ${input.kind},
              ${q.json(config as never)}, ${input.icon}, ${input.sortOrder}, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapNameConflict);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

export async function updateProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string,
   patch: PropertyPatch
): Promise<PropertyDefinition> {
   const restoring = patch.archived === false;
   const current = await getProperty(q, workspaceId, propertyId, restoring);
   if (patch.options && !SELECT_KINDS.has(current.kind)) throw new PropertyKindMismatch();
   // Restoring takes a slot back, so it is bounded exactly as creating is —
   // otherwise the cap would be a rule about the Add button rather than about
   // how many properties a workspace has.
   if (restoring && current.archivedAt !== null) {
      const [counted] = await q`
         SELECT count(*)::int AS active FROM issue_property_definitions
          WHERE workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (Number(counted?.active ?? 0) >= MAX_ACTIVE_PROPERTIES) throw new TooManyProperties();
   }
   const config = patch.options ? q.json({ options: patch.options } as never) : null;
   const rows = await q`
      UPDATE issue_property_definitions SET
         archived_at = CASE WHEN ${restoring} THEN NULL ELSE archived_at END,
         name = COALESCE(${patch.name ?? null}, name),
         description = CASE WHEN ${patch.description !== undefined} THEN ${patch.description ?? null}::text ELSE description END,
         config = COALESCE(${config}::jsonb, config),
         icon = CASE WHEN ${patch.icon !== undefined} THEN ${patch.icon ?? null}::text ELSE icon END,
         sort_order = COALESCE(${patch.sortOrder ?? null}::integer, sort_order),
         updated_at = now()
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId}
         AND (${restoring}::boolean OR archived_at IS NULL)
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapNameConflict);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

/** Archived rather than deleted: stored values stay, and reappear on restore. */
export async function archiveProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string
): Promise<boolean> {
   const rows = await q`
      UPDATE issue_property_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      RETURNING id`;
   return rows.length === 1;
}

const personSchema = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();
type Person = z.infer<typeof personSchema>;

function isHttpUrl(value: string): boolean {
   try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
   } catch {
      return false;
   }
}

function valueSchemaFor(definition: PropertyDefinition): z.ZodType<unknown> {
   const optionIds = definition.options.map((option) => option.id);
   switch (definition.kind) {
      case 'text':
         return z.string().max(5000);
      case 'number':
         return z.number().refine(Number.isFinite, { message: 'Must be a finite number.' });
      case 'boolean':
         return z.boolean();
      case 'date':
         return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD.' });
      case 'url':
         return z.string().max(2000).refine(isHttpUrl, { message: 'Must be an http or https URL.' });
      case 'select':
         return z.string().refine((value) => optionIds.includes(value), { message: 'Not an option of this property.' });
      case 'multi_select':
         return z
            .array(z.string())
            .max(100)
            .refine((values) => values.every((value) => optionIds.includes(value)), { message: 'Not an option of this property.' })
            .refine((values) => new Set(values).size === values.length, { message: 'Options must not repeat.' });
      case 'person':
         return personSchema;
      case 'multi_person':
         return z.array(personSchema).max(50);
   }
}

async function assertPeopleInWorkspace(q: Queryable, workspaceId: string, people: Person[]): Promise<void> {
   for (const person of people) {
      const [row] =
         person.type === 'user'
            ? await q`SELECT 1 FROM workspace_memberships WHERE workspace_id = ${workspaceId} AND user_id = ${person.id}`
            : await q`SELECT 1 FROM agents WHERE workspace_id = ${workspaceId} AND id = ${person.id}`;
      if (!row) {
         throw new InvalidPropertyValue([{ path: '/value', message: 'That person is not in this workspace.' }]);
      }
   }
}

export async function listValues(
   q: Queryable,
   workspaceId: string,
   issueId: string
): Promise<Array<{ propertyId: string; value: unknown }>> {
   const rows = await q`
      SELECT value.property_id, value.value
        FROM issue_property_values AS value
        JOIN issue_property_definitions AS definition
          ON definition.workspace_id = value.workspace_id AND definition.id = value.property_id
       WHERE value.workspace_id = ${workspaceId} AND value.issue_id = ${issueId}
         AND definition.archived_at IS NULL
       ORDER BY definition.sort_order, definition.id`;
   return rows.map((row) => ({ propertyId: row.property_id as string, value: row.value }));
}

export async function setValue(
   q: Queryable,
   input: { workspaceId: string; issueId: string; propertyId: string; value: unknown; actorId: string }
): Promise<{ propertyId: string; value: unknown }> {
   const definition = await getProperty(q, input.workspaceId, input.propertyId);
   const parsed = valueSchemaFor(definition).safeParse(input.value);
   if (!parsed.success) {
      throw new InvalidPropertyValue(
         parsed.error.issues.map((issue) => ({
            path: `/value${issue.path.length ? `/${issue.path.map(String).join('/')}` : ''}`,
            message: issue.message,
         }))
      );
   }
   if (definition.kind === 'person') await assertPeopleInWorkspace(q, input.workspaceId, [parsed.data as Person]);
   if (definition.kind === 'multi_person') await assertPeopleInWorkspace(q, input.workspaceId, parsed.data as Person[]);

   await q`
      INSERT INTO issue_property_values (workspace_id, issue_id, property_id, value, updated_by)
      VALUES (${input.workspaceId}, ${input.issueId}, ${input.propertyId},
              ${q.json(parsed.data as never)}, ${input.actorId})
      ON CONFLICT (workspace_id, issue_id, property_id)
      DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
   return { propertyId: input.propertyId, value: parsed.data };
}

export async function clearValue(
   q: Queryable,
   workspaceId: string,
   issueId: string,
   propertyId: string
): Promise<boolean> {
   const rows = await q`
      DELETE FROM issue_property_values
       WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId} AND property_id = ${propertyId}
      RETURNING property_id`;
   return rows.length === 1;
}
