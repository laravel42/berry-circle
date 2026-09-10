import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const subscriberSchema = z.object({
   userId: z.string(),
   name: z.string().nullable(),
   avatarUrl: z.string().nullable(),
   reason: z.string(),
   subscribedAt: z.string(),
});
export type Subscriber = z.infer<typeof subscriberSchema>;

const path = (issueRef: string) => `/api/v1/issues/${encodeURIComponent(issueRef)}`;

export async function loadSubscribers(issueRef: string): Promise<{ nodes: Subscriber[]; subscribed: boolean }> {
   return parseResponse(
      z.object({ nodes: z.array(subscriberSchema), subscribed: z.boolean() }),
      await apiFetch(`${path(issueRef)}/subscribers`),
      'Subscribers'
   );
}

export async function setSubscription(issueRef: string, subscribed: boolean, subtree: boolean): Promise<void> {
   if (subscribed) {
      await apiFetch(`${path(issueRef)}/subscription`, { method: 'PUT', body: JSON.stringify({ subtree }) });
   } else {
      await apiFetch(`${path(issueRef)}/subscription${subtree ? '?subtree=true' : ''}`, { method: 'DELETE' });
   }
}
