/**
 * OpenFang pinned-contract smoke test — agent create/list/get/update.
 *
 * Exercises the agent lifecycle surface of the pinned OpenFang revision
 * (acf2587e46be174c10200489c9a2d23a39a98aeb) that Berry's gateway adapter is
 * built on. The assertions lock the *reconciled* contract documented in
 * docs/api/openfang-gateway-consumption.md (normative) and summarized in
 * docs/integrations/berry-openfang.md — in particular that agent updates split
 * across two endpoints on this revision:
 *
 *   - PUT   /api/agents/{id}/update  requires a full `manifest_toml` and only
 *     ACKNOWLEDGES it (does not apply in place); a partial body is 422.
 *   - PATCH /api/agents/{id}         applies partial field edits
 *     (name/description/system_prompt/model) and is observable via GET.
 *
 * This is an integration test against a live substrate, not a unit test. It is
 * intentionally named `*-smoke.ts` (not `*.test.ts`) so the default `bun test`
 * CI run does not auto-discover it; run it explicitly with
 * `bun run test:smoke:openfang` after standing up the pinned OpenFang (see
 * docs/adr/0003-pin-openfang-by-commit.md). When no OpenFang is reachable at
 * OPENFANG_BASE_URL the whole suite skips itself so it stays green off-substrate.
 */
import { afterAll, describe, expect, it } from "bun:test";

const BASE_URL = (process.env.OPENFANG_BASE_URL ?? "http://localhost:4200").replace(/\/+$/, "");
const API_KEY = process.env.OPENFANG_API_KEY;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await isReachable();
if (!reachable) {
  console.warn(
    `[openfang-smoke] No OpenFang reachable at ${BASE_URL}/api/health — skipping. Stand up the pinned revision and set OPENFANG_BASE_URL to run this suite.`,
  );
}

// Unique per run so repeat runs and parallel workers never collide on the name.
const agentName = `berry-smoke-${crypto.randomUUID().slice(0, 8)}`;
const description = "Berry OpenFang smoke agent";
const manifestToml = [
  `name = "${agentName}"`,
  'version = "0.1.0"',
  `description = "${description}"`,
  'author = "berry-gateway-smoke"',
  'module = "builtin:chat"',
  "",
  "[model]",
  'provider = "default"',
  'model = "default"',
].join("\n");

describe.skipIf(!reachable)("openfang pinned contract — agent create/list/get/update", () => {
  let agentId = "";

  afterAll(async () => {
    if (!agentId) return;
    // Best-effort teardown; never fail the suite on cleanup.
    try {
      await fetch(`${BASE_URL}/api/agents/${agentId}/uninstall`, {
        method: "DELETE",
        headers: headers(),
      });
    } catch {
      // ignore
    }
  });

  it("create — POST /api/agents returns 201 { agent_id, name }", async () => {
    const res = await fetch(`${BASE_URL}/api/agents`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ manifest_toml: manifestToml }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id?: string; name?: string };
    expect(typeof body.agent_id).toBe("string");
    expect(body.agent_id).toBeTruthy();
    expect(body.name).toBe(agentName);
    agentId = body.agent_id as string;
  });

  it("list — GET /api/agents returns an array including the new agent", async () => {
    const res = await fetch(`${BASE_URL}/api/agents`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((a) => a.id === agentId);
    expect(found).toBeDefined();
    expect(found?.name).toBe(agentName);
  });

  it("get — GET /api/agents/{id} returns the agent detail", async () => {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; description: string };
    expect(body.id).toBe(agentId);
    expect(body.name).toBe(agentName);
    expect(body.description).toBe(description);
  });

  it("update guard — PUT /api/agents/{id}/update rejects a partial body with 422", async () => {
    // The documented-but-wrong partial body from BERR-49. The pinned DTO's only
    // field is a required `manifest_toml`, so axum's JSON extractor rejects this
    // with 422 (`missing field manifest_toml`). Locking it stops the adapter
    // from regressing to a PUT-based partial patch.
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/update`, {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ description: "Berry smoke update", tags: ["berry-smoke"] }),
    });
    expect(res.status).toBe(422);
  });

  it("update ack — PUT /api/agents/{id}/update with a full manifest returns 200 acknowledged", async () => {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/update`, {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ manifest_toml: manifestToml }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; agent_id: string };
    // Pinned router validates the manifest but does not apply it in place.
    expect(body.status).toBe("acknowledged");
    expect(body.agent_id).toBe(agentId);
  });

  it("update apply — PATCH /api/agents/{id} applies a partial field edit", async () => {
    const nextDescription = "Berry smoke update (patched)";
    const patch = await fetch(`${BASE_URL}/api/agents/${agentId}`, {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ description: nextDescription }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { status: string; agent_id: string };
    expect(patchBody.status).toBe("ok");
    expect(patchBody.agent_id).toBe(agentId);

    // The edit is observable — proves PATCH applies where PUT/update only acks.
    const get = await fetch(`${BASE_URL}/api/agents/${agentId}`, { headers: headers() });
    expect(get.status).toBe(200);
    const detail = (await get.json()) as { description: string };
    expect(detail.description).toBe(nextDescription);
  });
});
