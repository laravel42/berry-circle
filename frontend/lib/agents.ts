import type { User } from '@/data/users';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiBlob, apiFetch, BerryApiError } from './api';
import { connectionSchema } from './api-schemas';
import { toUiUser } from './catalog';

const agentSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   avatarUrl: z.string().nullable(),
   status: z.string(),
   capabilities: z.array(z.string()),
   /** System prompt applied to every task this agent runs. Markdown. */
   instructions: z.string().nullish(),
   modelProvider: z.string().nullish(),
   modelName: z.string().nullish(),
   /**
    * What this agent may do. Absence is denial, so an empty list is an agent
    * that can be assigned work and cannot act on it.
    */
   permissions: z.array(z.string()).default([]),
   labels: z.array(z.string()).default([]),
   /** Names only: env values are sealed on the server and never sent back. */
   envNames: z.array(z.string()).default([]),
   access: z.object({ assign: z.string(), mention: z.string() }).optional(),
   /** A seeded role such as 'guide'. */
   systemRole: z.string().nullish(),
   archivedAt: z.string().nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const agentConnectionSchema = connectionSchema(agentSchema);

export type Agent = z.infer<typeof agentSchema>;

const PREFERRED_AGENT_NAMES = ['berry-prototype', 'hello-world', 'assistant', 'coder'];

export interface AgentStatusDisplay {
   label: string;
   tone: 'online' | 'busy' | 'offline' | 'unknown';
}

/** Map gateway AgentStatus to list UI copy. */
export function agentStatusDisplay(status: string): AgentStatusDisplay {
   switch (status) {
      case 'available':
         return { label: 'Online', tone: 'online' };
      case 'busy':
         return { label: 'Busy', tone: 'busy' };
      case 'offline':
         return { label: 'Offline', tone: 'offline' };
      default:
         return { label: 'Unknown', tone: 'unknown' };
   }
}

export interface AgentModelDisplay {
   /** Bare model name for a cell, or a dash when none is assigned. */
   label: string;
   /** Provider-qualified full id for a tooltip; absent when nothing is assigned. */
   title?: string;
}

/**
 * Bare model name: `minimax/minimax-m2.7:free` → `minimax-m2.7`.
 *
 * Routed ids carry the vendor as a path (`anthropic/claude-sonnet-5`, or even
 * `openrouter/anthropic/…` when the runtime repeats its own prefix) and a
 * pricing tier as a suffix (`:free`, `:batch`). Both are how the model is
 * bought, not what it is, so a list cell drops them and the full id stays in
 * the tooltip.
 */
export function bareModelName(modelId: string): string {
   const withoutVendor = modelId.slice(modelId.lastIndexOf('/') + 1);
   const tier = withoutVendor.indexOf(':');
   return tier > 0 ? withoutVendor.slice(0, tier) : withoutVendor;
}

/**
 * The LLM an agent runs on, for list and summary cells.
 *
 * The label is the bare name; provider and full id go into the title so a
 * hover still attributes the model. Berry's built-in orchestrator has no
 * runtime model, which is what the dash means.
 */
export function agentModelDisplay(
   agent: Pick<Agent, 'modelProvider' | 'modelName'>
): AgentModelDisplay {
   const model = agent.modelName?.trim();
   if (!model) return { label: '—' };
   const provider = agent.modelProvider?.trim();
   return {
      label: bareModelName(model) || model,
      title: provider ? `${provider} · ${model}` : model,
   };
}

/** Load workspace agents. */
export async function loadWorkspaceAgents(): Promise<Agent[]> {
   const collected: Agent[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/agents?${params.toString()}`);
      const parsed = agentConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Agent list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) {
         break;
      }
      after = endCursor;
   }
   return collected;
}

export async function getWorkspaceAgent(agentId: string): Promise<Agent> {
   const json: unknown = await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}`);
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Agent response was not recognized');
   }
   return parsed.data;
}

/**
 * Write the agent configuration Berry authors.
 *
 * A resolved promise means the server accepted and stored the change. An
 * omitted field is left unchanged; an empty string clears it.
 */
const modelSchema = z.object({
   id: z.string(),
   displayName: z.string(),
   provider: z.string(),
   tier: z.string(),
   contextWindow: z.number(),
   inputCostPerM: z.number(),
   outputCostPerM: z.number(),
   supportsTools: z.boolean(),
   supportsVision: z.boolean(),
});

export type AgentModel = z.infer<typeof modelSchema>;

/**
 * Models this runtime can actually serve.
 *
 * The server filters to available ones, so anything listed here has a
 * configured provider behind it — a model that would fail on the agent's next
 * task is never offered.
 */
export async function listAgentModels(): Promise<AgentModel[]> {
   const json: unknown = await apiFetch('/api/v1/agents/models');
   const parsed = z.object({ nodes: z.array(modelSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Model list was not recognized');
   return parsed.data.nodes;
}

/**
 * `$3`, `$1.25`, `$0.021` — what a million tokens costs.
 *
 * Three significant figures rather than a fixed number of decimals, because
 * these prices span four orders of magnitude: the catalog quotes Sonnet at $3
 * and Ling at $0.021, and any single decimal count is either noise at the top
 * ($3.00) or a lie at the bottom ($0.02, and $0.00 for anything cheaper).
 * Trailing zeros are dropped so the common whole-dollar prices stay short.
 */
export function modelPrice(perMillion: number): string {
   if (!Number.isFinite(perMillion) || perMillion < 0) return '—';
   if (perMillion === 0) return '$0';
   // Above $100 a cent is not information, and toPrecision would switch to
   // exponential notation at four digits anyway.
   if (perMillion >= 100) return `$${Math.round(perMillion)}`;
   const figures = perMillion.toPrecision(3);
   // Trailing zeros only ever follow a decimal point. Stripping them from a
   // whole number turns $100 into $1.
   const trimmed = figures.includes('.') ? figures.replace(/0+$/, '').replace(/\.$/, '') : figures;
   return `$${trimmed}`;
}

export interface AgentPriceDisplay {
   /** `$3 / $15`, `Free`, or a dash when the price is not known. */
   label: string;
   /** What the two numbers mean; absent when there is nothing to explain. */
   title?: string;
}

/**
 * What the agent's assigned model costs, input then output.
 *
 * Priced from the catalog rather than from the agent, because that is where
 * price lives: an agent stores which model it runs on, and what that model
 * costs is the provider's business and changes without the agent changing.
 *
 * A dash covers two different unknowns — no model assigned, and a model the
 * catalog no longer offers — and says the same thing about both, which is that
 * Berry cannot quote a price. Distinguishing them in a table cell would be
 * detail nobody is reading the column for.
 */
export function agentPriceDisplay(
   agent: Pick<Agent, 'modelProvider' | 'modelName'>,
   prices: Map<string, AgentModel>
): AgentPriceDisplay {
   const provider = agent.modelProvider?.trim();
   const model = agent.modelName?.trim();
   if (!provider || !model) return { label: '—' };
   const entry = prices.get(`${provider}/${model}`);
   if (!entry) return { label: '—' };
   if (entry.inputCostPerM === 0 && entry.outputCostPerM === 0) {
      return { label: 'Free', title: `${entry.displayName} costs nothing to run` };
   }
   return {
      label: `${modelPrice(entry.inputCostPerM)} / ${modelPrice(entry.outputCostPerM)}`,
      title: `${entry.displayName}: ${modelPrice(entry.inputCostPerM)} in, ${modelPrice(
         entry.outputCostPerM
      )} out, per million tokens`,
   };
}

/** Key a catalog model the way an agent stores its pairing. */
export function modelKey(model: Pick<AgentModel, 'provider' | 'id'>): string {
   return `${model.provider}/${model.id}`;
}

/** Cross-region routing prefixes Bedrock puts on a profile id. */
const ROUTING_PREFIXES = ['us-gov', 'us', 'eu', 'apac', 'apne', 'global'];

/**
 * The vendor that makes a model, derived from its Bedrock id.
 *
 * Every catalog row is served by the same provider (`bedrock`), so grouping on
 * `provider` yields one bucket. The useful axis is the vendor, which Bedrock
 * encodes as the id segment after the routing prefix:
 * `us.anthropic.claude-…` → `anthropic`, `qwen.qwen3-32b-v1:0` → `qwen`. An id
 * that does not match this shape falls back to its provider.
 */
export function modelVendor(model: Pick<AgentModel, 'id' | 'provider'>): string {
   const segments = model.id.split('.');
   if (segments.length >= 2) {
      const first = segments[0]!.toLowerCase();
      // A leading routing prefix (`us.`, `global.`) is not the vendor; the
      // vendor is the segment after it.
      const vendor = ROUTING_PREFIXES.includes(first) ? segments[1] : segments[0];
      if (vendor) return vendor.toLowerCase();
   }
   return model.provider;
}

export async function updateAgentConfig(
   agentId: string,
   config: {
      instructions?: string;
      description?: string;
      provider?: string;
      model?: string;
   }
): Promise<Agent> {
   const json: unknown = await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
   });
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Agent response was not recognized');
   }
   return parsed.data;
}

export function agentToUser(agent: Agent): User {
   return toUiUser({
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      type: 'agent',
   });
}

/** Prefer the prototype OpenRouter agent, then other ready runtimes. */
export function pickRunnableAgent(agents: Agent[]): Agent | undefined {
   for (const name of PREFERRED_AGENT_NAMES) {
      const match = agents.find(
         (agent) => agent.name === name && agent.status !== 'offline' && agent.status !== 'unknown'
      );
      if (match) return match;
   }
   return (
      agents.find((agent) => agent.status === 'available') ??
      agents.find((agent) => agent.status !== 'offline') ??
      agents[0]
   );
}

/**
 * What an agent may do, in the order a person reads them.
 *
 * `merge_without_approval` is last and separate on purpose: it is the one
 * that makes the human review gate advisory, and it is not a default.
 */
export const AGENT_PERMISSIONS = [
   { key: 'read_repository', label: 'Read the repository', description: 'Clone it and read its files.' },
   { key: 'create_branches', label: 'Create branches', description: 'Push a branch named for the task.' },
   { key: 'run_commands', label: 'Run commands', description: 'Run builds and tests in an isolated workspace.' },
   {
      key: 'open_pull_requests',
      label: 'Open pull requests',
      description: 'Open a pull request for a person to review.',
   },
   {
      key: 'merge_without_approval',
      label: 'Merge without approval',
      description: 'Merge its own work with no human review. Off by default.',
      dangerous: true,
   },
] as const;

/** Replaces the whole set; every enforcement point reads it as a set. */
export async function setAgentPermissions(
   agentId: string,
   permissions: string[]
): Promise<Agent> {
   const json: unknown = await apiFetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/permissions`,
      { method: 'PUT', body: JSON.stringify({ permissions }) }
   );
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent response was not recognized');
   return parsed.data;
}

// ------------------------------------------------------------ agent layer

const runNodeSchema = z.object({
   id: z.string(),
   status: z.string(),
   issueId: z.string().nullish(),
   createdAt: z.string(),
   completedAt: z.string().nullish(),
});
export type AgentTask = z.infer<typeof runNodeSchema>;

const parseAgent = (json: unknown): Agent => {
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent response was not recognized');
   return parsed.data;
};
const agentPath = (id: string, rest = '') => `/api/v1/agents/${encodeURIComponent(id)}${rest}`;

export async function loadArchivedAgents(): Promise<Agent[]> {
   const json: unknown = await apiFetch('/api/v1/agents?archived=true&first=100');
   const parsed = agentConnectionSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent list was not recognized');
   return parsed.data.nodes;
}

export const restoreAgent = async (id: string) =>
   parseAgent(await apiFetch(agentPath(id, '/restore'), { method: 'POST', body: '{}' }));

export const copyAgent = async (id: string) =>
   parseAgent(
      await apiFetch(agentPath(id, '/copy'), {
         method: 'POST',
         headers: { 'idempotency-key': crypto.randomUUID() },
         body: '{}',
      })
   );

export async function archiveAgent(id: string): Promise<void> {
   await apiFetch(agentPath(id), { method: 'DELETE' });
}

export async function cancelAgentTasks(id: string): Promise<number> {
   const json: unknown = await apiFetch(agentPath(id, '/cancel-tasks'), { method: 'POST', body: '{}' });
   return z.object({ cancelled: z.number() }).parse(json).cancelled;
}

export async function listAgentTasks(id: string, after?: string) {
   const query = `/tasks?first=50${after ? `&after=${encodeURIComponent(after)}` : ''}`;
   const json: unknown = await apiFetch(agentPath(id, query));
   return connectionSchema(runNodeSchema).parse(json);
}

export const setAgentLabels = async (id: string, labels: string[]) =>
   parseAgent(await apiFetch(agentPath(id, '/labels'), { method: 'PUT', body: JSON.stringify({ labels }) }));

/** Replaces every variable; the response carries names only. */
export async function setAgentEnv(id: string, env: Record<string, string>): Promise<string[]> {
   const json: unknown = await apiFetch(agentPath(id, '/env'), {
      method: 'PUT',
      body: JSON.stringify({ env }),
   });
   return z.object({ envNames: z.array(z.string()) }).parse(json).envNames;
}

export const uploadAgentAvatar = async (id: string, file: File) =>
   parseAgent(
      await apiFetch(agentPath(id, '/avatar'), {
         method: 'PUT',
         headers: { 'content-type': file.type },
         body: file,
      })
   );

export const agentAccessSchema = z.object({
   assign: z.enum(['everyone', 'admins', 'listed']),
   mention: z.enum(['everyone', 'admins', 'listed']),
   members: z.array(z.string()),
});
export type AgentAccess = z.infer<typeof agentAccessSchema>;

export const getAgentAccess = async (id: string) =>
   agentAccessSchema.parse(await apiFetch(agentPath(id, '/access')));

export const setAgentAccess = async (id: string, access: AgentAccess) =>
   parseAgent(await apiFetch(agentPath(id, '/permissions'), { method: 'PUT', body: JSON.stringify({ access }) }));

/** The workspace's guide agent, or null when it has none (archived, say). */
export async function getGuideAgent(): Promise<Agent | null> {
   try {
      return parseAgent(await apiFetch('/api/v1/agents/guide'));
   } catch (error) {
      if (error instanceof BerryApiError && error.status === 404) return null;
      throw error;
   }
}

const avatarCache = new Map<string, Promise<string>>();

/**
 * A usable `src` for an agent avatar.
 *
 * An external `https://` URL is used as is. An avatar Berry serves lives behind
 * the API's bearer authentication, which an `<img>` cannot send, so it is
 * fetched once through the API client and shown from a blob URL. The `?v=` in
 * the path changes on every upload, so the cache never serves a stale picture.
 */
export function useAgentAvatarSrc(avatarUrl: string | null | undefined): string | null {
   const external = avatarUrl && /^https?:\/\//.test(avatarUrl) ? avatarUrl : null;
   const [src, setSrc] = useState<string | null>(external);

   useEffect(() => {
      if (!avatarUrl) {
         setSrc(null);
         return;
      }
      if (/^https?:\/\//.test(avatarUrl)) {
         setSrc(avatarUrl);
         return;
      }
      if (!avatarUrl.startsWith('/api/v1/agents/')) {
         setSrc(null);
         return;
      }
      let cancelled = false;
      let pending = avatarCache.get(avatarUrl);
      if (!pending) {
         pending = apiBlob(avatarUrl, { headers: { accept: 'image/*' } }).then((blob) =>
            URL.createObjectURL(blob)
         );
         avatarCache.set(avatarUrl, pending);
         pending.catch(() => avatarCache.delete(avatarUrl));
      }
      pending.then(
         (url) => {
            if (!cancelled) setSrc(url);
         },
         () => {
            if (!cancelled) setSrc(null);
         }
      );
      return () => {
         cancelled = true;
      };
   }, [avatarUrl]);

   return src;
}
