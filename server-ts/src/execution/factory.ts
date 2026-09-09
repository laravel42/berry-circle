import type { AgentCoreConfig, ExecutionConfig } from '../config/config.ts';
import { agentCoreDriver } from './agentcore.ts';
import { agentCoreRuntimeDriver } from './agentcore-runtime.ts';
import { httpDriver } from './http.ts';
import { unconfiguredDriver, type ExecutionDriver } from './driver.ts';

/**
 * Config to a driver.
 *
 * The one place a driver name becomes an implementation. It stays a switch so
 * the day a substrate needs its own transport, this is the only file that has
 * to change — and the compiler says so, because the union is exhausted below.
 *
 * A deployment with no substrate configured gets a driver that refuses, not
 * `null`: the caller then has one failure mode to handle instead of two, and
 * the refusal names what is missing.
 *
 * The AgentCore substrates take their settings from `agentCore` rather than the
 * execution config, because a region, an interpreter id and a runtime ARN are
 * AgentCore's own and mean nothing to the Docker substrate.
 */
export function createExecutionDriver(
   config: ExecutionConfig | null,
   agentCore: AgentCoreConfig | null = null
): ExecutionDriver {
   if (!config) {
      return unconfiguredDriver(
         'no execution substrate is configured; set BERRY_RUNTIME_DRIVER'
      );
   }
   switch (config.driver) {
      case 'agentcore':
         if (!agentCore) {
            return unconfiguredDriver(
               'BERRY_RUNTIME_DRIVER is agentcore but no AgentCore settings are configured; set BERRY_AGENTCORE_REGION and BERRY_AGENTCORE_CODE_INTERPRETER_ID'
            );
         }
         return agentCoreDriver({
            region: agentCore.region,
            codeInterpreterId: agentCore.codeInterpreterId,
            ...(agentCore.credentials ? { credentials: agentCore.credentials } : {}),
         });
      case 'agentcore-runtime':
         // The Runtimes substrate needs a deployed runtime to invoke, addressed
         // by ARN. Without it there is nothing to call, so the driver refuses
         // by name rather than failing at the first command.
         if (!agentCore) {
            return unconfiguredDriver(
               'BERRY_RUNTIME_DRIVER is agentcore-runtime but no AgentCore settings are configured; set BERRY_AGENTCORE_REGION and BERRY_AGENTCORE_RUNTIME_ARN'
            );
         }
         if (!agentCore.runtimeArn) {
            return unconfiguredDriver(
               'BERRY_RUNTIME_DRIVER is agentcore-runtime but BERRY_AGENTCORE_RUNTIME_ARN is not set'
            );
         }
         return agentCoreRuntimeDriver({
            region: agentCore.region,
            runtimeArn: agentCore.runtimeArn,
            ...(agentCore.credentials ? { credentials: agentCore.credentials } : {}),
         });
      case 'docker':
         return httpDriver({
            baseUrl: config.baseUrl,
            token: config.token,
            name: config.driver,
         });
      default: {
         // Unreachable while the union is exhausted above, and a compile error
         // the day it gains a member without a case here.
         const unsupported: never = config.driver;
         return unconfiguredDriver(`unsupported execution driver: ${String(unsupported)}`);
      }
   }
}
