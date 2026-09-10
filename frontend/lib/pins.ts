import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const pinSchema = z.object({
   id: z.string(),
   targetType: z.enum(['issue', 'view', 'project']),
   targetId: z.string(),
   position: z.number(),
   title: z.string(),
   identifier: z.string().nullable(),
});
export type Pin = z.infer<typeof pinSchema>;
const pinsSchema = z.object({ nodes: z.array(pinSchema) });

export async function loadPins(workspaceId: string): Promise<Pin[]> {
   return parseResponse(pinsSchema, await apiFetch(`/api/v1/pins?workspaceId=${encodeURIComponent(workspaceId)}`), 'Pins').nodes;
}

export async function pinTarget(
   workspaceId: string,
   targetType: Pin['targetType'],
   targetId: string
): Promise<Pin> {
   return parseResponse(
      pinSchema,
      await apiFetch('/api/v1/pins', { method: 'POST', body: JSON.stringify({ workspaceId, targetType, targetId }) }),
      'Pin'
   );
}

export async function unpinTarget(workspaceId: string, pinId: string): Promise<void> {
   await apiFetch(`/api/v1/pins/${encodeURIComponent(pinId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
}

export async function reorderPins(workspaceId: string, ids: string[]): Promise<Pin[]> {
   return parseResponse(
      pinsSchema,
      await apiFetch('/api/v1/pins/order', { method: 'PUT', body: JSON.stringify({ workspaceId, ids }) }),
      'Pins'
   ).nodes;
}
