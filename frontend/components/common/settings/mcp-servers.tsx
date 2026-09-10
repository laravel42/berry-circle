'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BerryApiError } from '@/lib/api';
import {
   createMcpServer,
   deleteMcpServer,
   listMcpServers,
   updateMcpServer,
   type McpServer,
   type McpTransport,
} from '@/lib/mcp';

interface HeaderRow {
   name: string;
   value: string;
}

const failure = (error: unknown, fallback: string) =>
   error instanceof BerryApiError && error.status === 403
      ? 'Only workspace admins can change MCP servers.'
      : error instanceof BerryApiError
        ? error.message
        : fallback;

const toHeaders = (rows: HeaderRow[]) =>
   Object.fromEntries(rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]));

/** Header name/value rows. Values are typed here and sent once; they never come back. */
function HeaderRows({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
   return (
      <div className="flex flex-col gap-2">
         {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
               <Input
                  value={row.name}
                  placeholder="Header"
                  aria-label="Header name"
                  onChange={(event) =>
                     onChange(rows.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)))
                  }
               />
               <Input
                  type="password"
                  value={row.value}
                  placeholder="Value"
                  aria-label="Header value"
                  autoComplete="off"
                  onChange={(event) =>
                     onChange(rows.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))
                  }
               />
               <Button
                  size="xs"
                  variant="ghost"
                  aria-label="Remove header"
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
               >
                  <Trash2 className="size-4" />
               </Button>
            </div>
         ))}
         <Button
            size="xs"
            variant="secondary"
            className="w-fit"
            onClick={() => onChange([...rows, { name: '', value: '' }])}
         >
            <Plus className="size-4" />
            Add header
         </Button>
      </div>
   );
}

function ServerRow({
   server,
   readOnly,
   onChanged,
   onRemoved,
}: {
   server: McpServer;
   readOnly: boolean;
   onChanged: (server: McpServer) => void;
   onRemoved: (id: string) => void;
}) {
   const [replacing, setReplacing] = useState(false);
   const [rows, setRows] = useState<HeaderRow[]>([{ name: '', value: '' }]);

   const patch = async (work: () => Promise<McpServer>, done: string) => {
      try {
         onChanged(await work());
         toast.success(done);
      } catch (error) {
         toast.error(failure(error, 'The server could not be updated.'));
      }
   };

   return (
      <li className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
         <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
               <p className="truncate font-medium">{server.name}</p>
               <p className="truncate text-muted-foreground">
                  {server.url} · {server.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}
                  {server.viaGateway ? ' · through AgentCore Gateway' : ''}
               </p>
               {server.headerNames.length > 0 ? (
                  <p className="text-muted-foreground">
                     {server.headerNames.map((name) => `${name}: ••••`).join(' · ')}
                  </p>
               ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
               <Switch
                  checked={server.enabled}
                  disabled={readOnly}
                  aria-label={`Enable ${server.name}`}
                  onCheckedChange={(enabled) =>
                     void patch(() => updateMcpServer(server.id, { enabled }), enabled ? 'Server enabled' : 'Server disabled')
                  }
               />
               {readOnly ? null : (
                  <>
                     <Button size="xs" variant="secondary" onClick={() => setReplacing(!replacing)}>
                        Replace headers
                     </Button>
                     <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Remove ${server.name}`}
                        onClick={() =>
                           void deleteMcpServer(server.id).then(
                              () => onRemoved(server.id),
                              (error: unknown) => toast.error(failure(error, 'The server could not be removed.'))
                           )
                        }
                     >
                        <Trash2 className="size-4" />
                     </Button>
                  </>
               )}
            </div>
         </div>
         {replacing ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted/30 p-3">
               <p className="text-muted-foreground">Saving replaces every header on this server.</p>
               <HeaderRows rows={rows} onChange={setRows} />
               <Button
                  size="xs"
                  className="w-fit"
                  onClick={() =>
                     void patch(() => updateMcpServer(server.id, { headers: toHeaders(rows) }), 'Headers replaced').then(
                        () => {
                           setReplacing(false);
                           setRows([{ name: '', value: '' }]);
                        }
                     )
                  }
               >
                  Save headers
               </Button>
            </div>
         ) : null}
      </li>
   );
}

function AddServerForm({ agentId, onAdded }: { agentId: string | null; onAdded: (server: McpServer) => void }) {
   const [name, setName] = useState('');
   const [url, setUrl] = useState('');
   const [transport, setTransport] = useState<McpTransport>('streamable_http');
   const [rows, setRows] = useState<HeaderRow[]>([]);
   const [viaGateway, setViaGateway] = useState(false);
   const [busy, setBusy] = useState(false);

   const submit = async () => {
      setBusy(true);
      try {
         const server = await createMcpServer({
            agentId,
            name: name.trim(),
            url: url.trim(),
            transport,
            headers: toHeaders(rows),
            viaGateway,
            enabled: true,
         });
         onAdded(server);
         setName('');
         setUrl('');
         setRows([]);
         setViaGateway(false);
         toast.success(`Added ${server.name}`);
      } catch (error) {
         toast.error(failure(error, 'The server could not be added.'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
         <p className="font-medium">Add a server</p>
         <div className="grid gap-2 sm:grid-cols-2">
            <Input
               value={name}
               placeholder="name (lowercase, e.g. docs)"
               aria-label="Server name"
               onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            <Input
               value={url}
               placeholder="https://example.com/mcp"
               aria-label="Server URL"
               onChange={(event) => setUrl(event.target.value)}
            />
         </div>
         <Select value={transport} onValueChange={(value) => setTransport(value as McpTransport)}>
            <SelectTrigger className="w-60" aria-label="Transport">
               <SelectValue />
            </SelectTrigger>
            <SelectContent>
               <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
               <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
         </Select>
         <HeaderRows rows={rows} onChange={setRows} />
         <label className="flex items-center gap-2">
            <Switch checked={viaGateway} onCheckedChange={setViaGateway} />
            <span>Route through AgentCore Gateway</span>
         </label>
         <Button
            size="sm"
            className="w-fit"
            disabled={busy || !name.trim() || !url.trim()}
            onClick={() => void submit()}
         >
            Add server
         </Button>
      </div>
   );
}

interface McpServerManagerProps {
   /** null manages workspace-wide servers; an id manages that agent's own. */
   agentId: string | null;
   /** Show the list without the add, edit and remove controls. */
   readOnly?: boolean;
}

/** A list of MCP servers with their controls; header values are write-only. */
export function McpServerManager({ agentId, readOnly = false }: McpServerManagerProps) {
   const [servers, setServers] = useState<McpServer[] | null>(null);
   const [error, setError] = useState<string | null>(null);

   const load = useCallback(async () => {
      setServers(await listMcpServers(agentId ?? 'workspace'));
   }, [agentId]);

   useEffect(() => {
      load().catch((failed: unknown) => setError(failure(failed, 'MCP servers could not be loaded.')));
   }, [load]);

   if (error) return <p className="text-muted-foreground">{error}</p>;
   if (!servers) return <p className="text-muted-foreground">Loading servers…</p>;

   return (
      <div className="flex flex-col gap-3">
         {servers.length === 0 ? (
            <p className="text-muted-foreground">No servers yet.</p>
         ) : (
            <ul className="flex flex-col rounded-md border border-border">
               {servers.map((server) => (
                  <ServerRow
                     key={server.id}
                     server={server}
                     readOnly={readOnly}
                     onChanged={(next) => setServers((current) => current?.map((s) => (s.id === next.id ? next : s)) ?? null)}
                     onRemoved={(id) => setServers((current) => current?.filter((s) => s.id !== id) ?? null)}
                  />
               ))}
            </ul>
         )}
         {readOnly ? null : (
            <AddServerForm agentId={agentId} onAdded={(server) => setServers((current) => [...(current ?? []), server])} />
         )}
      </div>
   );
}

/** Settings → MCP servers: the servers every agent in the workspace connects to. */
export default function McpServersSettings() {
   return (
      <div className="flex max-w-3xl flex-col gap-4">
         <div>
            <h2 className="font-medium">MCP servers</h2>
            <p className="text-muted-foreground">
               Servers every agent in this workspace can use. Header values are encrypted and never shown again.
            </p>
         </div>
         <McpServerManager agentId={null} />
      </div>
   );
}
