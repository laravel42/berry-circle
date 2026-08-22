/**
 * OpenFang adapter (BERR-20) — the gateway's isolated boundary to the upstream
 * OpenFang API. This barrel re-exports the public surface with no side effects;
 * for a client wired to the gateway's env config, import
 * `createConfiguredOpenFangClient` from `~/openfang/factory`.
 */

export { OpenFangClient, createOpenFangClient } from "~/openfang/client";
export type { OpenFangClientOptions, StreamOptions } from "~/openfang/client";
export { OpenFangError } from "~/openfang/errors";
export type { OpenFangErrorCode, OpenFangErrorOptions } from "~/openfang/errors";
export { parseOpenFangStream, parseFrame } from "~/openfang/sse";
export type { OpenFangStreamEvent } from "~/openfang/sse";
export type { AdapterLogger, FetchLike, IdempotencyClass, RetryConfig } from "~/openfang/http";
export * from "~/openfang/types";
