import { z } from 'zod';
import { apiFetch } from './api';

/**
 * The workspace skills catalogue: reusable instructions (and files) an agent
 * carries into its tasks. Created by hand, or imported from a GitHub folder or
 * a zip, and switched on per agent.
 */

const fileSchema = z.object({ path: z.string(), size: z.number(), content: z.string().optional() });

export const skillSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string(),
   content: z.string(),
   labels: z.array(z.string()),
   source: z.object({
      kind: z.enum(['manual', 'github', 'zip']),
      url: z.string().nullable(),
      ref: z.string().nullable(),
      importedAt: z.string().nullable(),
   }),
   files: z.array(fileSchema),
   agentEnabled: z.boolean().nullable().optional(),
   /** Who wrote or imported it; null once that account is gone. */
   createdBy: z.string().nullable().default(null),
   creatorName: z.string().nullable().default(null),
   /** The agents that carry it, and whether each has it switched on. */
   agents: z
      .array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() }))
      .default([]),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type Skill = z.infer<typeof skillSchema>;

/** An agent carries a skill only when a binding says so and is switched on. */
export const isSkillInUse = (skill: Skill): boolean => skill.agents.some((agent) => agent.enabled);

export interface SkillFilters {
   q?: string;
   label?: string;
   agentId?: string;
   source?: Skill['source']['kind'];
   createdBy?: string;
   /** True lists only skills an agent carries; false only those none does. */
   inUse?: boolean;
}

export interface SkillInput {
   name: string;
   description: string;
   content: string;
   labels: string[];
   files: { path: string; content: string }[];
}

function parse(json: unknown): Skill {
   const parsed = skillSchema.safeParse(json);
   if (!parsed.success) throw new Error('Skill response was not recognized');
   return parsed.data;
}

const skillPath = (id: string, rest = '') => `/api/v1/skills/${encodeURIComponent(id)}${rest}`;

export async function listSkills(params: SkillFilters = {}): Promise<Skill[]> {
   const query = new URLSearchParams(
      Object.entries(params)
         .filter(([, value]) => value !== undefined && value !== '')
         .map(([name, value]) => [name, String(value)])
   );
   const json: unknown = await apiFetch(`/api/v1/skills${query.size ? `?${query}` : ''}`);
   const parsed = z.object({ nodes: z.array(skillSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Skill list was not recognized');
   return parsed.data.nodes;
}

export const getSkill = async (id: string) => parse(await apiFetch(skillPath(id)));

export const createSkill = async (input: SkillInput) =>
   parse(
      await apiFetch('/api/v1/skills', {
         method: 'POST',
         headers: { 'idempotency-key': crypto.randomUUID() },
         body: JSON.stringify(input),
      })
   );

export const updateSkill = async (id: string, patch: Partial<SkillInput>) =>
   parse(await apiFetch(skillPath(id), { method: 'PATCH', body: JSON.stringify(patch) }));

export async function deleteSkill(id: string): Promise<void> {
   await apiFetch(skillPath(id), { method: 'DELETE' });
}

export const importSkillFromUrl = async (url: string) =>
   parse(
      await apiFetch('/api/v1/skills/import', {
         method: 'POST',
         headers: { 'idempotency-key': crypto.randomUUID() },
         body: JSON.stringify({ url }),
      })
   );

/** `apiFetch` sets a JSON content type only for a string body, so the zip keeps its own. */
export const importSkillZip = async (file: File) =>
   parse(
      await apiFetch('/api/v1/skills/import/zip', {
         method: 'POST',
         headers: { 'content-type': 'application/zip', 'idempotency-key': crypto.randomUUID() },
         body: file,
      })
   );

export const refreshSkill = async (id: string) =>
   parse(await apiFetch(skillPath(id, '/refresh'), { method: 'POST', body: '{}' }));

/** `enabled: null` removes the binding, leaving the agent with no opinion on the skill. */
export async function setSkillForAgent(
   skillId: string,
   agentId: string,
   enabled: boolean | null
): Promise<void> {
   const path = skillPath(skillId, `/agents/${encodeURIComponent(agentId)}`);
   await apiFetch(
      path,
      enabled === null ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ enabled }) }
   );
}
