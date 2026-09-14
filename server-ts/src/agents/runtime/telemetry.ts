import type { Logger } from '../../observability/log.ts';

/**
 * Traces and metrics from the agent SDK, when somewhere to send them exists.
 *
 * The SDK records a span per model call and per tool call on its own; what it
 * needs is a provider with an exporter. That provider comes from OpenTelemetry
 * packages the SDK lists as peers and Berry does not ship, so this is loaded
 * on demand: a deployment that sets `OTEL_EXPORTER_OTLP_ENDPOINT` and has
 * installed the packages gets traces, and one that has not gets one warning
 * and a server that runs exactly as before.
 */
export async function setupTelemetry(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
   const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
   if (!endpoint) return false;
   try {
      const telemetry = await import('@strands-agents/sdk/telemetry');
      telemetry.setupTracer({ exporters: { otlp: true } });
      telemetry.setupMeter({ exporters: { otlp: true } });
      logger.info('agent telemetry enabled', { endpoint });
      return true;
   } catch (error) {
      logger.warn('agent telemetry is configured but could not start', {
         endpoint,
         error: error instanceof Error ? error.message : String(error),
         hint: 'install the @opentelemetry peer packages the Strands SDK lists',
      });
      return false;
   }
}
