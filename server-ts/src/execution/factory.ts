import type { ExecutionConfig } from '../config/config.ts';
import { httpDriver } from './http.ts';
import { unconfiguredDriver, type ExecutionDriver } from './driver.ts';

/**
 * Config to a driver.
 *
 * Both substrates speak the same protocol, so this maps a name to a label
 * rather than to a different client. It stays a switch because the day a
 * substrate needs its own transport, this is the one place that has to change
 * — and the compiler will say so.
 *
 * A deployment with no substrate configured gets a driver that refuses, not
 * `null`: the caller then has one failure mode to handle instead of two, and
 * the refusal names what is missing.
 */
export function createExecutionDriver(config: ExecutionConfig | null): ExecutionDriver {
   if (!config) {
      return unconfiguredDriver(
         'no execution substrate is configured; set BERRY_RUNTIME_DRIVER, BERRY_RUNTIME_URL and BERRY_RUNTIME_TOKEN'
      );
   }
   switch (config.driver) {
      case 'docker':
      case 'cloudflare':
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
