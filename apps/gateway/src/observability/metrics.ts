import type { Histogram, UpDownCounter } from "@opentelemetry/api";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider, type ViewOptions } from "@opentelemetry/sdk-metrics";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { config } from "~/config";
import { logger } from "~/logger";

/** Content type for the Prometheus text exposition format (v0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// Second-scale latency buckets; the OTel defaults are tuned for milliseconds.
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// The instrument name carries the `seconds` unit because
// exporter-prometheus@0.221.0's serializer does NOT fold `unit:"s"` into the
// series name (only `.`→`_`, and `_total` for counters) — it would surface a
// unit only as an OpenMetrics `# UNIT` comment that the `version=0.0.4` text
// format ignores. Baking the unit into the name yields the conventional
// Prometheus `*_seconds` series that the docs and dashboards expect.
const HTTP_SERVER_DURATION = "http.server.request.duration.seconds";
const HTTP_SERVER_ACTIVE = "http.server.active_requests";
const OPENFANG_CLIENT_DURATION = "openfang.client.request.duration.seconds";

interface MetricsState {
  provider: MeterProvider;
  exporter: PrometheusExporter;
  serializer: PrometheusSerializer;
  httpServerDuration: Histogram;
  httpServerActive: UpDownCounter;
  openfangClientDuration: Histogram;
}

let state: MetricsState | null = null;

function histogramView(instrumentName: string): ViewOptions {
  return {
    instrumentName,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: DURATION_BUCKETS_SECONDS },
    },
  };
}

function build(): MetricsState {
  // `preventServerStart` keeps the exporter from binding its own :9464 server;
  // we scrape it on demand through the gateway's own `/metrics` route instead.
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: config.SERVICE_VERSION,
    "deployment.environment.name": config.NODE_ENV,
  });
  const provider = new MeterProvider({
    resource,
    readers: [exporter],
    views: [histogramView(HTTP_SERVER_DURATION), histogramView(OPENFANG_CLIENT_DURATION)],
  });
  const meter = provider.getMeter(config.SERVICE_NAME);

  const httpServerDuration = meter.createHistogram(HTTP_SERVER_DURATION, {
    description: "Duration in seconds of inbound HTTP requests handled by the gateway.",
  });
  const httpServerActive = meter.createUpDownCounter(HTTP_SERVER_ACTIVE, {
    description: "Number of in-flight inbound HTTP requests.",
  });
  const openfangClientDuration = meter.createHistogram(OPENFANG_CLIENT_DURATION, {
    description:
      "Duration in seconds of outbound requests from the gateway to the OpenFang substrate.",
  });

  return {
    provider,
    exporter,
    serializer: new PrometheusSerializer(),
    httpServerDuration,
    httpServerActive,
    openfangClientDuration,
  };
}

function ensure(): MetricsState {
  if (!state) {
    state = build();
  }
  return state;
}

/** Mark the start of an inbound request (increments the in-flight gauge). */
export function markRequestStart(): void {
  if (!config.METRICS_ENABLED) return;
  ensure().httpServerActive.add(1);
}

export interface HttpRequestSample {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}

/** Record a completed inbound request (duration + decrements the in-flight gauge). */
export function markRequestEnd(sample: HttpRequestSample): void {
  if (!config.METRICS_ENABLED) return;
  const s = ensure();
  s.httpServerActive.add(-1);
  s.httpServerDuration.record(sample.durationSeconds, {
    [ATTR_HTTP_REQUEST_METHOD]: sample.method,
    [ATTR_HTTP_ROUTE]: sample.route,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: sample.status,
  });
}

export interface OpenfangRequestSample {
  method: string;
  /** Low-cardinality templated route, e.g. `GET /api/agents/:id`. */
  route: string;
  /** HTTP status code, or `"error"` for transport failures. */
  status: number | "error";
  durationSeconds: number;
}

/** Record a completed outbound request from the gateway to OpenFang. */
export function recordOpenfangClientRequest(sample: OpenfangRequestSample): void {
  if (!config.METRICS_ENABLED) return;
  ensure().openfangClientDuration.record(sample.durationSeconds, {
    "openfang.request.method": sample.method,
    "openfang.route": sample.route,
    "openfang.response.status_code": String(sample.status),
  });
}

/** Collect and serialize all metrics into the Prometheus text exposition format. */
export async function renderMetrics(): Promise<string> {
  const s = ensure();
  const { resourceMetrics, errors } = await s.exporter.collect();
  if (errors.length > 0) {
    logger.warn({ errors }, "metrics collection reported errors");
  }
  return s.serializer.serialize(resourceMetrics);
}

/** Shut down the meter provider; call during graceful shutdown. */
export async function shutdownMetrics(): Promise<void> {
  if (state) {
    await state.provider.shutdown();
    state = null;
  }
}

/** Test-only: drop the provider so the next call rebuilds fresh instruments. */
export async function resetMetricsForTest(): Promise<void> {
  await shutdownMetrics();
}
