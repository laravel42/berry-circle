/** Data of the Integrations settings page (settings/integrations). */

export type IntegrationStatus = 'enabled' | 'pre-installed';

export interface Integration {
   id: string;
   name: string;
   description: string;
   status?: IntegrationStatus;
   /** Background color of the generated icon. */
   color: string;
}

export interface IntegrationCategory {
   id: string;
   label: string;
   /** Integration ids, in display order. */
   items: string[];
}

/** Populated via the gateway API at runtime. */
const list: Integration[] = [];

export const INTEGRATIONS: Record<string, Integration> = Object.fromEntries(
   list.map((integration) => [integration.id, integration])
);

/** Populated via the gateway API at runtime. */
export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [];

export const ENABLED_INTEGRATIONS: Integration[] = list.filter(
   (integration) => integration.status === 'enabled'
);
