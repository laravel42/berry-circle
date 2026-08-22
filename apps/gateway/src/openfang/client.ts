/**
 * Typed OpenFang adapter client (BERR-20).
 *
 * One method per endpoint in the pinned consumption contract
 * (`docs/api/openfang-gateway-consumption.md`). Requests are validated before
 * dispatch (the upstream handler silently coerces or ignores bad input), and
 * responses are parsed into the contract's typed shapes at the boundary — so
 * the rest of the gateway trusts the types and never touches raw upstream JSON.
 *
 * Field names on the returned values stay `snake_case` to match the wire; the
 * gateway's public DTO layer (BERR-22/23/26) maps them to Berry's camel-case
 * API. Memory keys are passed through verbatim — key prefixing (the
 * `berry:<workspaceId>:<agentId>:<logicalKey>` convention that keeps the shared
 * upstream namespace from colliding) is the caller's responsibility.
 */

import type { z } from "zod";
import { OpenFangError } from "~/openfang/errors";
import {
  type AdapterLogger,
  DEFAULT_RETRY,
  type FetchLike,
  HttpTransport,
  type RequestSpec,
  type RetryConfig,
  type TransportContext,
} from "~/openfang/http";
import { type OpenFangStreamEvent, parseOpenFangStream } from "~/openfang/sse";
import {
  type AgentDetail,
  type AgentSession,
  type AgentSummary,
  type AuditPage,
  type CreateWorkflowResponse,
  type KillAgentResponse,
  type KvListResponse,
  type KvPair,
  type MemoryMutationResponse,
  type MessageStreamRequest,
  type PatchAgentRequest,
  type PatchAgentResponse,
  type SpawnAgentRequest,
  type SpawnAgentResponse,
  type StopAgentResponse,
  type UsageByAgent,
  type WorkflowDetail,
  type WorkflowMutationResponse,
  type WorkflowRunRequest,
  type WorkflowRunResponse,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowWriteRequest,
  agentDetailSchema,
  agentListSchema,
  agentSessionSchema,
  auditPageSchema,
  createWorkflowResponseSchema,
  killAgentResponseSchema,
  kvListResponseSchema,
  kvPairSchema,
  memoryMutationResponseSchema,
  messageStreamRequestSchema,
  patchAgentRequestSchema,
  patchAgentResponseSchema,
  spawnAgentRequestSchema,
  spawnAgentResponseSchema,
  stopAgentResponseSchema,
  usageByAgentSchema,
  workflowDetailSchema,
  workflowMutationResponseSchema,
  workflowRunListSchema,
  workflowRunRequestSchema,
  workflowRunResponseSchema,
  workflowSummarySchema,
  workflowWriteRequestSchema,
} from "~/openfang/types";

export interface OpenFangClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Injectable for tests; defaults to a real timer-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  logger?: AdapterLogger;
  /** Default timeout for non-streaming requests (ms). */
  timeoutMs?: number;
  /** Default timeout covering the whole lifetime of a stream (ms). */
  streamTimeoutMs?: number;
  retry?: Partial<RetryConfig>;
}

export interface StreamOptions {
  /** Override the whole-stream timeout for this dispatch. */
  timeoutMs?: number;
  /** Cancel the stream (e.g. when the downstream client disconnects). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

export class OpenFangClient {
  private readonly transport: HttpTransport;

  constructor(options: OpenFangClientOptions) {
    const ctx: TransportContext = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      apiKey: options.apiKey,
      fetchImpl: options.fetch ?? fetch,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      logger: options.logger,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      streamTimeoutMs: options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
      retry: { ...DEFAULT_RETRY, ...options.retry },
    };
    this.transport = new HttpTransport(ctx);
  }

  // --- Agent lifecycle ---

  listAgents(): Promise<AgentSummary[]> {
    return this.read(agentListSchema, "GET /api/agents", { method: "GET", path: "/api/agents" });
  }

  spawnAgent(request: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    const body = validateRequest(spawnAgentRequestSchema, request);
    return this.send(spawnAgentResponseSchema, "POST /api/agents", {
      method: "POST",
      path: "/api/agents",
      body,
      expectStatus: 201,
    });
  }

  getAgent(agentId: string): Promise<AgentDetail> {
    const path = `/api/agents/${encodeURIComponent(agentId)}`;
    return this.read(agentDetailSchema, `GET ${path}`, { method: "GET", path });
  }

  patchAgent(agentId: string, request: PatchAgentRequest): Promise<PatchAgentResponse> {
    const body = validateRequest(patchAgentRequestSchema, request);
    const path = `/api/agents/${encodeURIComponent(agentId)}`;
    return this.send(patchAgentResponseSchema, `PATCH ${path}`, { method: "PATCH", path, body });
  }

  killAgent(agentId: string): Promise<KillAgentResponse> {
    const path = `/api/agents/${encodeURIComponent(agentId)}`;
    return this.send(killAgentResponseSchema, `DELETE ${path}`, { method: "DELETE", path });
  }

  // --- Agent execution, runs, and streaming ---

  /**
   * Dispatch the primary run and consume its SSE events. Never retried and
   * never re-dispatched: on interruption the generator throws
   * `STREAM_INTERRUPTED` after yielding the partial events it did receive.
   */
  async *streamAgentMessage(
    agentId: string,
    request: MessageStreamRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<OpenFangStreamEvent> {
    const body = validateRequest(messageStreamRequestSchema, request);
    const handle = await this.transport.openStream({
      method: "POST",
      path: `/api/agents/${encodeURIComponent(agentId)}/message/stream`,
      body,
      accept: "text/event-stream",
      idempotency: "unsafe",
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    try {
      yield* parseOpenFangStream(handle.body);
    } finally {
      // Release the upstream socket on EVERY exit — normal `done`, an early
      // consumer `break` (downstream disconnect), or a thrown
      // `STREAM_INTERRUPTED`. `dispose()` only clears the whole-stream timeout
      // and abort wiring, so without an explicit cancel the abnormal-exit paths
      // would leave the `text/event-stream` connection open with no reaper.
      // `parseOpenFangStream` has already released the reader lock in its own
      // `finally`, so `cancel()` is safe here and a harmless no-op on the
      // already-cancelled `done`/EOF paths.
      try {
        await handle.body.cancel();
      } catch {
        // Body already cancelled or settled — nothing left to release.
      }
      handle.dispose();
    }
  }

  stopAgent(agentId: string): Promise<StopAgentResponse> {
    const path = `/api/agents/${encodeURIComponent(agentId)}/stop`;
    return this.send(stopAgentResponseSchema, `POST ${path}`, { method: "POST", path });
  }

  getSession(agentId: string): Promise<AgentSession> {
    // `include_system` is deliberately omitted so upstream system prompts stay
    // out of the reconciliation view.
    const path = `/api/agents/${encodeURIComponent(agentId)}/session`;
    return this.read(agentSessionSchema, `GET ${path}`, { method: "GET", path });
  }

  getRecentAudit(count?: number): Promise<AuditPage> {
    return this.read(auditPageSchema, "GET /api/audit/recent", {
      method: "GET",
      path: "/api/audit/recent",
      query: count === undefined ? undefined : { n: count },
    });
  }

  getUsage(): Promise<UsageByAgent> {
    return this.read(usageByAgentSchema, "GET /api/usage", { method: "GET", path: "/api/usage" });
  }

  // --- Memory (shared global namespace; caller prefixes keys) ---

  listMemory(agentId: string): Promise<KvListResponse> {
    const path = `/api/memory/agents/${encodeURIComponent(agentId)}/kv`;
    return this.read(kvListResponseSchema, `GET ${path}`, { method: "GET", path });
  }

  getMemory(agentId: string, key: string): Promise<KvPair> {
    const path = memoryKeyPath(agentId, key);
    return this.read(kvPairSchema, `GET ${path}`, { method: "GET", path });
  }

  putMemory(agentId: string, key: string, value: unknown): Promise<MemoryMutationResponse> {
    const path = memoryKeyPath(agentId, key);
    // Always use the explicit `{ value }` wrapper so upstream stores exactly the
    // intended value and never the bare envelope.
    return this.send(memoryMutationResponseSchema, `PUT ${path}`, {
      method: "PUT",
      path,
      body: { value },
      idempotency: "idempotent-write",
    });
  }

  deleteMemory(agentId: string, key: string): Promise<MemoryMutationResponse> {
    const path = memoryKeyPath(agentId, key);
    // Not auto-retried (default `unsafe`). The contract classifies retry per
    // operation: memory PUT is idempotent-retryable, but "Deletes may be
    // repeated only through an explicit reconciliation action that understands
    // 404/missing semantics" — so DELETE must not silently consume the upstream
    // rate-limit budget the contract reserves for reads/PUTs.
    return this.send(memoryMutationResponseSchema, `DELETE ${path}`, {
      method: "DELETE",
      path,
    });
  }

  // --- Workflows ---

  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.read(workflowSummarySchema.array(), "GET /api/workflows", {
      method: "GET",
      path: "/api/workflows",
    });
  }

  createWorkflow(request: WorkflowWriteRequest): Promise<CreateWorkflowResponse> {
    const body = validateRequest(workflowWriteRequestSchema, request);
    return this.send(createWorkflowResponseSchema, "POST /api/workflows", {
      method: "POST",
      path: "/api/workflows",
      body,
      expectStatus: 201,
    });
  }

  getWorkflow(workflowId: string): Promise<WorkflowDetail> {
    const path = `/api/workflows/${encodeURIComponent(workflowId)}`;
    return this.read(workflowDetailSchema, `GET ${path}`, { method: "GET", path });
  }

  updateWorkflow(
    workflowId: string,
    request: WorkflowWriteRequest,
  ): Promise<WorkflowMutationResponse> {
    const body = validateRequest(workflowWriteRequestSchema, request);
    const path = `/api/workflows/${encodeURIComponent(workflowId)}`;
    return this.send(workflowMutationResponseSchema, `PUT ${path}`, { method: "PUT", path, body });
  }

  deleteWorkflow(workflowId: string): Promise<WorkflowMutationResponse> {
    const path = `/api/workflows/${encodeURIComponent(workflowId)}`;
    return this.send(workflowMutationResponseSchema, `DELETE ${path}`, { method: "DELETE", path });
  }

  /** Execute a workflow synchronously; uses the longer stream-tier timeout. */
  runWorkflow(
    workflowId: string,
    request: WorkflowRunRequest = {},
    options: { timeoutMs?: number } = {},
  ): Promise<WorkflowRunResponse> {
    const body = validateRequest(workflowRunRequestSchema, request);
    const path = `/api/workflows/${encodeURIComponent(workflowId)}/run`;
    return this.send(workflowRunResponseSchema, `POST ${path}`, {
      method: "POST",
      path,
      body,
      timeoutMs: options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
    });
  }

  listWorkflowRuns(workflowId: string): Promise<WorkflowRunSummary[]> {
    // The pinned handler ignores {workflowId} and returns runs for every
    // workflow; the caller must filter and must not treat this as a boundary.
    const path = `/api/workflows/${encodeURIComponent(workflowId)}/runs`;
    return this.read(workflowRunListSchema, `GET ${path}`, { method: "GET", path });
  }

  // --- internals ---

  /** Retryable read: safe GETs. */
  private async read<T extends z.ZodTypeAny>(
    schema: T,
    label: string,
    spec: Omit<RequestSpec, "idempotency">,
  ): Promise<z.infer<T>> {
    const { data, requestId } = await this.transport.request({ ...spec, idempotency: "read" });
    return parseResponse(schema, data, requestId, label);
  }

  /** Non-retryable write/dispatch, unless the spec opts into an idempotency class. */
  private async send<T extends z.ZodTypeAny>(
    schema: T,
    label: string,
    spec: RequestSpec,
  ): Promise<z.infer<T>> {
    const { data, requestId } = await this.transport.request(spec);
    return parseResponse(schema, data, requestId, label);
  }
}

/** Build a factory-friendly client from explicit options. */
export function createOpenFangClient(options: OpenFangClientOptions): OpenFangClient {
  return new OpenFangClient(options);
}

function memoryKeyPath(agentId: string, key: string): string {
  return `/api/memory/agents/${encodeURIComponent(agentId)}/kv/${encodeURIComponent(key)}`;
}

function validateRequest<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new OpenFangError(
      "INVALID_REQUEST",
      `Invalid OpenFang request: ${formatIssues(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

function parseResponse<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  requestId: string | null,
  label: string,
): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new OpenFangError(
      "UPSTREAM_INVALID_RESPONSE",
      `OpenFang ${label} returned an unexpected shape: ${formatIssues(parsed.error)}`,
      { requestId, cause: parsed.error },
    );
  }
  return parsed.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
