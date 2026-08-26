import type { User } from '@/data/users';
import { z } from 'zod';
import { apiFetch } from './api';
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

/** Load workspace agents; OpenFang summaries are reconciled server-side. */
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
 * The server pushes this to OpenFang before storing it, so a resolved promise
 * means the runtime accepted the change — not merely that Berry recorded it.
 * An omitted field is left unchanged; an empty string clears it.
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
