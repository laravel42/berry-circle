import { z } from 'zod';
import { apiFetch } from './api';

/**
 * The settings pages, as the server serves them.
 *
 * Two groups, and the split matters: `/api/v1/me/*` is a person's own — their
 * sessions, the addresses Berry can reach them at, what it may tell them
 * about — and `/api/v1/catalogs/*` is the workspace's vocabulary, which
 * everyone shares. Reading a vocabulary needs only membership because every
 * list in the product renders it; editing one needs `settings.write`.
 */

// ------------------------------------------------------------------ profile

const profileSchema = z.object({
   id: z.string(),
   email: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullish(),
});

const userSettingsSchema = z.object({
   theme: z.string(),
   timezone: z.string(),
   reducedMotion: z.boolean(),
   // Defaulted so a server without the field still parses.
   locale: z.string().default('en'),
});

export type Profile = z.infer<typeof profileSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;

export async function loadProfile(): Promise<Profile> {
   return parse(profileSchema, await apiFetch('/api/v1/me'), 'Profile');
}

/** `avatarUrl: null` clears it; omitting it leaves what is there. */
export async function saveProfile(patch: {
   name?: string;
   avatarUrl?: string | null;
}): Promise<Profile> {
   return parse(
      profileSchema,
      await apiFetch('/api/v1/me', { method: 'PATCH', body: JSON.stringify(patch) }),
      'Profile'
   );
}

export async function loadUserSettings(): Promise<UserSettings> {
   return parse(userSettingsSchema, await apiFetch('/api/v1/me/settings'), 'Settings');
}

export async function saveUserSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
   return parse(
      userSettingsSchema,
      await apiFetch('/api/v1/me/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
      'Settings'
   );
}

// ----------------------------------------------------------------- sessions

const sessionSchema = z.object({
   id: z.string(),
   userAgent: z.string().nullable(),
   ip: z.string().nullable(),
   createdAt: z.string(),
   lastUsedAt: z.string().nullable(),
   expiresAt: z.string(),
});

export type AccountSession = z.infer<typeof sessionSchema>;

export async function loadSessions(): Promise<AccountSession[]> {
   return parse(
      z.object({ nodes: z.array(sessionSchema) }),
      await apiFetch('/api/v1/me/sessions'),
      'Sessions'
   ).nodes;
}

export async function revokeSession(sessionId: string): Promise<void> {
   await apiFetch(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

/**
 * "Chrome on macOS" from a user-agent string.
 *
 * Approximate on purpose. A security page needs someone to recognise their
 * own laptop, not to identify a build — and the full string is unreadable.
 */
export function describeDevice(userAgent: string | null): string {
   if (!userAgent) return 'Unknown device';
   const browser =
      /Edg\//.test(userAgent) ? 'Edge'
      : /OPR\//.test(userAgent) ? 'Opera'
      : /Chrome\//.test(userAgent) ? 'Chrome'
      : /Safari\//.test(userAgent) ? 'Safari'
      : /Firefox\//.test(userAgent) ? 'Firefox'
      : 'A browser';
   const platform =
      /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
      : /Windows/.test(userAgent) ? 'Windows'
      : /Android/.test(userAgent) ? 'Android'
      : /iPhone|iPad/.test(userAgent) ? 'iOS'
      : /Linux/.test(userAgent) ? 'Linux'
      : null;
   return platform ? `${browser} on ${platform}` : browser;
}

// ------------------------------------------------------------- api tokens

const tokenSchema = z.object({
   id: z.string(),
   name: z.string(),
   /** The visible half. The secret is returned once, on creation, and never again. */
   prefix: z.string(),
   lastUsedAt: z.string().nullable(),
   expiresAt: z.string().nullable(),
   revokedAt: z.string().nullable(),
   createdAt: z.string(),
   /** Public API scopes; null means every scope (keys made before scopes existed). */
   scopes: z.array(z.string()).nullish(),
});

export type PersonalToken = z.infer<typeof tokenSchema>;

export async function loadTokens(): Promise<PersonalToken[]> {
   const found = parse(
      z.object({ nodes: z.array(tokenSchema) }),
      await apiFetch('/api/v1/tokens?first=100'),
      'Tokens'
   ).nodes;
   // A revoked token is not access anyone has; keeping it in the list would
   // make the real ones harder to see.
   return found.filter((token) => !token.revokedAt);
}

/** The public API scopes a personal key can hold. Storage belongs to plugins only. */
export const API_SCOPES = [
   'issues:read',
   'issues:write',
   'comments:read',
   'comments:write',
] as const;

/**
 * Creates a token and returns the secret once.
 *
 * The secret is in this response and nowhere else — the server stores a hash —
 * so a caller that drops it has to make another one. On an idempotent replay
 * the server omits it rather than sending null, and this says so.
 */
export async function createToken(
   name: string,
   scopes: string[] | null = null
): Promise<{ secret: string | null; record: PersonalToken }> {
   const json: unknown = await apiFetch('/api/v1/tokens', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(scopes === null ? { name } : { name, scopes }),
   });
   const parsed = parse(
      z.object({ personalToken: tokenSchema, token: z.string().optional() }),
      json,
      'Token'
   );
   return { secret: parsed.token ?? null, record: parsed.personalToken };
}

export async function revokeToken(tokenId: string): Promise<void> {
   await apiFetch(`/api/v1/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------ notifications

export const NOTIFICATION_KEYS = [
   'assignments',
   'mentions',
   'comments',
   'statusChanges',
   'approvals',
   'goals',
   'updates',
   'agentActivity',
] as const;

export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];
export type NotificationSwitches = Record<NotificationKey, boolean>;

const notificationsSchema = z.object({
   workspaceId: z.string(),
   inApp: z.record(z.boolean()),
});

export async function loadNotifications(workspaceId: string): Promise<NotificationSwitches> {
   const json = await apiFetch(
      `/api/v1/me/notifications?workspaceId=${encodeURIComponent(workspaceId)}`
   );
   return parse(notificationsSchema, json, 'Notification settings').inApp as NotificationSwitches;
}

/** One switch at a time; the server merges, so the others keep their value. */
export async function saveNotification(
   workspaceId: string,
   key: NotificationKey,
   enabled: boolean
): Promise<NotificationSwitches> {
   const json = await apiFetch('/api/v1/me/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId, inApp: { [key]: enabled } }),
   });
   return parse(notificationsSchema, json, 'Notification settings').inApp as NotificationSwitches;
}

// ---------------------------------------------------------------- channels

export const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'TELEGRAM', 'VIBER', 'LIVE_CHAT'] as const;

const channelSchema = z.object({
   id: z.string(),
   channel: z.string(),
   address: z.string(),
   displayName: z.string().nullable(),
   verified: z.boolean(),
   preferred: z.boolean(),
   createdAt: z.string(),
});

export type ChannelIdentity = z.infer<typeof channelSchema>;

export async function loadChannels(): Promise<ChannelIdentity[]> {
   return parse(
      z.object({ nodes: z.array(channelSchema) }),
      await apiFetch('/api/v1/me/channels'),
      'Channels'
   ).nodes;
}

export async function addChannel(input: {
   channel: string;
   address: string;
   preferred?: boolean;
}): Promise<ChannelIdentity> {
   return parse(
      channelSchema,
      await apiFetch('/api/v1/me/channels', { method: 'POST', body: JSON.stringify(input) }),
      'Channel'
   );
}

export async function removeChannel(channelId: string): Promise<void> {
   await apiFetch(`/api/v1/me/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ labels

const labelSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   color: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
   archivedAt: z.string().nullable(),
});

export type WorkspaceLabel = z.infer<typeof labelSchema>;

export async function loadLabels(workspaceId: string): Promise<WorkspaceLabel[]> {
   const json = await apiFetch(
      `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-labels?first=100`
   );
   const parsed = z.object({ nodes: z.array(labelSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Label list was not recognized');
   // Archived labels stay nameable on the tasks that carry them, but the
   // settings page is about what a person can put on something new.
   return parsed.data.nodes.filter((label) => !label.archivedAt);
}

export async function createLabel(
   workspaceId: string,
   input: { name: string; color: string }
): Promise<WorkspaceLabel> {
   return parse(
      labelSchema,
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-labels`, {
         method: 'POST',
         body: JSON.stringify(input),
      }),
      'Label'
   );
}

export async function updateLabel(
   workspaceId: string,
   labelId: string,
   patch: { name?: string; color?: string }
): Promise<WorkspaceLabel> {
   return parse(
      labelSchema,
      await apiFetch(
         `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-labels/${encodeURIComponent(labelId)}`,
         { method: 'PATCH', body: JSON.stringify(patch) }
      ),
      'Label'
   );
}

export async function archiveLabel(workspaceId: string, labelId: string): Promise<void> {
   await apiFetch(
      `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
   );
}

// ---------------------------------------------------------------- statuses

const statusSchema = z.object({
   id: z.string(),
   key: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   category: z.string(),
   color: z.string(),
   sortOrder: z.number(),
   isSystem: z.boolean(),
});

export type WorkspaceStatus = z.infer<typeof statusSchema>;

export async function loadStatuses(workspaceId: string): Promise<WorkspaceStatus[]> {
   return parse(
      z.object({ nodes: z.array(statusSchema) }),
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses`),
      'Statuses'
   ).nodes;
}

/**
 * Renames or recolours a status.
 *
 * `key` and `category` are not patchable: the board's columns and the run
 * ledger address a status by category, so changing one would move every task
 * that is in it.
 */
export async function updateStatus(
   workspaceId: string,
   statusId: string,
   patch: { name?: string; color?: string }
): Promise<WorkspaceStatus> {
   return parse(
      statusSchema,
      await apiFetch(
         `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses/${encodeURIComponent(statusId)}`,
         { method: 'PATCH', body: JSON.stringify(patch) }
      ),
      'Status'
   );
}

// ------------------------------------------------------------------ helpers

function parse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}

export const STATUS_CATEGORIES = [
   'backlog',
   'todo',
   'in_progress',
   'in_review',
   'done',
   'blocked',
   'cancelled',
] as const;

export async function createStatus(
   workspaceId: string,
   input: { name: string; category: (typeof STATUS_CATEGORIES)[number]; color: string }
): Promise<WorkspaceStatus> {
   return parse(
      statusSchema,
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses`, {
         method: 'POST',
         body: JSON.stringify(input),
      }),
      'Status'
   );
}

export async function archiveStatus(workspaceId: string, statusId: string): Promise<void> {
   await apiFetch(
      `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses/${encodeURIComponent(statusId)}`,
      { method: 'DELETE' }
   );
}

export async function reorderStatuses(workspaceId: string, ids: string[]): Promise<WorkspaceStatus[]> {
   return parse(
      z.object({ nodes: z.array(statusSchema) }),
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses/order`, {
         method: 'PUT',
         body: JSON.stringify({ ids }),
      }),
      'Statuses'
   ).nodes;
}
