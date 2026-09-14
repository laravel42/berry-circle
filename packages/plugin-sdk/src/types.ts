/** The shapes Berry sends and accepts. They mirror the server's contract; see docs/api/gateway-v1.md. */

export type ApiScope =
   | 'issues:read'
   | 'issues:write'
   | 'comments:read'
   | 'comments:write'
   | 'storage:read'
   | 'storage:write';

export interface PluginManifest {
   schemaVersion: 1;
   key: string;
   name: string;
   version: string;
   description?: string;
   baseUrl: string;
   scopes?: ApiScope[];
   config?: { key: string; label: string; type: 'string' | 'number' | 'boolean'; required?: boolean }[];
   secrets?: { name: string; description?: string }[];
   hooks?: (
      | { key: string; trigger: 'event'; events: string[]; path: string }
      | { key: string; trigger: 'schedule'; everyMinutes: number; path: string }
   )[];
   surfaces?: { key: string; title: string; path: string }[];
   mcp?: { path: string; tools: { name: string; description?: string }[] };
}

export interface PluginPackage {
   manifest: PluginManifest;
   files?: { path: string; content: string }[];
}

export interface HookRequest {
   type: 'event' | 'schedule';
   trigger: string;
   pluginKey: string;
   installationId: string;
   workspaceId: string;
   config: Record<string, string | number | boolean>;
   secrets: Record<string, string>;
   api: { url: string | null; token: string; expiresAt: string };
   event: { id: string; type: string; occurredAt: string; payload: unknown } | null;
}

/** Typed identity: write a package in TypeScript and serialise it to berry-plugin.json. */
export function definePlugin(pkg: PluginPackage): PluginPackage {
   return pkg;
}
