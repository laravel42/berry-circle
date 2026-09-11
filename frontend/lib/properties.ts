import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

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

export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
   text: 'Text',
   number: 'Number',
   boolean: 'Checkbox',
   date: 'Date',
   url: 'URL',
   select: 'Select',
   multi_select: 'Multi-select',
   person: 'Person',
   multi_person: 'People',
};

const optionSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
export type PropertyOption = z.infer<typeof optionSchema>;

const definitionSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   kind: z.enum(PROPERTY_KINDS),
   options: z.array(optionSchema),
   icon: z.string().nullable(),
   sortOrder: z.number(),
   createdAt: z.string(),
   updatedAt: z.string(),
   archivedAt: z.string().nullable(),
});
export type PropertyDefinition = z.infer<typeof definitionSchema>;

const valueSchema = z.object({ propertyId: z.string(), value: z.unknown() });
export type PropertyValue = { propertyId: string; value: unknown };

const catalog = (workspaceId: string, suffix = '') =>
   `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-properties${suffix}`;
const onIssue = (issueRef: string, suffix: string) =>
   `/api/v1/issues/${encodeURIComponent(issueRef)}${suffix}`;

/**
 * The number of properties a workspace can have in use at once, mirroring the
 * server's own bound so the Add button can say no before the request does.
 */
export const MAX_ACTIVE_PROPERTIES = 20;

export async function loadProperties(
   workspaceId: string,
   includeArchived = false
): Promise<PropertyDefinition[]> {
   const query = includeArchived ? '?includeArchived=true' : '';
   return parseResponse(
      z.object({ nodes: z.array(definitionSchema) }),
      await apiFetch(catalog(workspaceId, query)),
      'Properties'
   ).nodes;
}

export async function createProperty(
   workspaceId: string,
   input: {
      name: string;
      kind: PropertyKind;
      options?: PropertyOption[];
      description?: string | null;
   }
): Promise<PropertyDefinition> {
   return parseResponse(
      definitionSchema,
      await apiFetch(catalog(workspaceId), { method: 'POST', body: JSON.stringify(input) }),
      'Property'
   );
}

export async function updateProperty(
   workspaceId: string,
   propertyId: string,
   patch: {
      name?: string;
      description?: string | null;
      options?: PropertyOption[];
      /** `false` restores an archived property; archiving is `archiveProperty`. */
      archived?: false;
   }
): Promise<PropertyDefinition> {
   return parseResponse(
      definitionSchema,
      await apiFetch(catalog(workspaceId, `/${encodeURIComponent(propertyId)}`), {
         method: 'PATCH',
         body: JSON.stringify(patch),
      }),
      'Property'
   );
}

export async function archiveProperty(workspaceId: string, propertyId: string): Promise<void> {
   await apiFetch(catalog(workspaceId, `/${encodeURIComponent(propertyId)}`), { method: 'DELETE' });
}

export async function loadIssueProperties(issueRef: string): Promise<PropertyValue[]> {
   const parsed = parseResponse(
      z.object({ nodes: z.array(valueSchema) }),
      await apiFetch(onIssue(issueRef, '/properties')),
      'Property values'
   );
   return parsed.nodes.map((node) => ({ propertyId: node.propertyId, value: node.value }));
}

export async function setIssueProperty(
   issueRef: string,
   propertyId: string,
   value: unknown
): Promise<void> {
   await apiFetch(onIssue(issueRef, `/properties/${encodeURIComponent(propertyId)}`), {
      method: 'PUT',
      body: JSON.stringify({ value }),
   });
}

export async function clearIssueProperty(issueRef: string, propertyId: string): Promise<void> {
   await apiFetch(onIssue(issueRef, `/properties/${encodeURIComponent(propertyId)}`), {
      method: 'DELETE',
   });
}

const metadataSchema = z.object({ metadata: z.record(z.unknown()) });

export async function loadIssueMetadata(issueRef: string): Promise<Record<string, unknown>> {
   return parseResponse(metadataSchema, await apiFetch(onIssue(issueRef, '/metadata')), 'Metadata')
      .metadata;
}

export async function patchIssueMetadata(
   issueRef: string,
   patch: { set?: Record<string, string | number | boolean | null>; remove?: string[] }
): Promise<Record<string, unknown>> {
   return parseResponse(
      metadataSchema,
      await apiFetch(onIssue(issueRef, '/metadata'), {
         method: 'PATCH',
         body: JSON.stringify(patch),
      }),
      'Metadata'
   ).metadata;
}
