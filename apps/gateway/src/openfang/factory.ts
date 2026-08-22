/**
 * Config-backed OpenFang client factory (BERR-20).
 *
 * Kept out of the barrel so `~/openfang` stays side-effect-free: importing this
 * module loads the gateway env config and the shared logger. The rest of the
 * gateway constructs its adapter through here.
 */

import { config } from "~/config";
import { logger } from "~/logger";
import { type OpenFangClient, createOpenFangClient } from "~/openfang/client";

/** Build an OpenFang client from the gateway's env config and shared logger. */
export function createConfiguredOpenFangClient(): OpenFangClient {
  return createOpenFangClient({
    baseUrl: config.OPENFANG_BASE_URL,
    apiKey: config.OPENFANG_API_KEY,
    logger,
  });
}
