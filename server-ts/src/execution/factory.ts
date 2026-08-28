import type { ExecutionConfig } from '../config/config.ts';
import { httpDriver } from './http.ts';
import { unconfiguredDriver, type ExecutionDriver } from './driver.ts';

/**
 * Config to a driver.
 *
 * The only place that maps a driver name to an implementation, which is what
 * keeps the choice to one line when a second substrate lands beside this one.
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
