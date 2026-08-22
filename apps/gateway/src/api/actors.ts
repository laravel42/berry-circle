import { inArray } from "drizzle-orm";
import type { BerryDb } from "~/db/client";
import { users } from "~/db/schema";

/**
 * Actor identity and display-name resolution.
 *
 * An {@link Actor} is *who is acting* (resolved from the request — today a dev
 * header seam, replaced by session auth in BERR-24). An {@link ActorRef} is the
 * public `type/id/name/avatarUrl` shape the contract embeds in issues and
 * comments, with the display name resolved at response time.
 *
 * User names resolve from the `users` table. Agent identities live in OpenFang,
 * not Berry's database; until the adapter (BERR-20) lands, agents resolve to a
 * stable placeholder ref so responses stay well-shaped. The wiring point is
 * {@link resolveRefs} — swap the agent branch for an adapter lookup.
 */

export type ActorType = "user" | "agent";

export interface Actor {
  type: ActorType;
  id: string;
  /** Release 1 stopgap for the "administrator may edit/delete any comment"
   * rule; real roles arrive with BERR-24. */
  isAdmin: boolean;
}

export interface ActorRef {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ActorKey {
  type: ActorType;
  id: string;
}

const AGENT_PLACEHOLDER_NAME = "Agent";
const UNKNOWN_USER_NAME = "Unknown user";

export function refKey(key: ActorKey): string {
  return `${key.type}:${key.id}`;
}

/** The fallback ref for an actor with no resolvable display name — a deleted
 * user, or (for now) any agent. Keeps a deleted actor referentially displayable
 * per the contract's consistency rules. */
function placeholderRef(key: ActorKey): ActorRef {
  return {
    type: key.type,
    id: key.id,
    name: key.type === "agent" ? AGENT_PLACEHOLDER_NAME : UNKNOWN_USER_NAME,
    avatarUrl: null,
  };
}

/**
 * Resolves a batch of actor references to their public display shape in a single
 * user query (no N+1 across a page of issues/comments). Every input key gets an
 * entry in the returned map.
 */
export async function resolveRefs(db: BerryDb, keys: ActorKey[]): Promise<Map<string, ActorRef>> {
  const out = new Map<string, ActorRef>();
  const userIds = [...new Set(keys.filter((k) => k.type === "user").map((k) => k.id))];

  const found = new Map<string, { name: string; avatarUrl: string | null }>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const row of rows) {
      found.set(row.id, { name: row.name, avatarUrl: row.avatarUrl });
    }
  }

  for (const key of keys) {
    const k = refKey(key);
    if (out.has(k)) continue;
    const user = key.type === "user" ? found.get(key.id) : undefined;
    out.set(k, user ? { type: "user", id: key.id, ...user } : placeholderRef(key));
  }
  return out;
}

/** Reads a resolved ref from a batch map, falling back to the placeholder if a
 * key was somehow absent (keeps callers total without a non-null assertion). */
export function requiredRef(refs: Map<string, ActorRef>, key: ActorKey): ActorRef {
  return refs.get(refKey(key)) ?? placeholderRef(key);
}

/** Resolves a single, always-present actor reference. */
export async function resolveRefRequired(db: BerryDb, key: ActorKey): Promise<ActorRef> {
  const refs = await resolveRefs(db, [key]);
  return requiredRef(refs, key);
}

/** Resolves an optional actor reference, or `null` when the key itself is null. */
export async function resolveRef(db: BerryDb, key: ActorKey | null): Promise<ActorRef | null> {
  if (!key) return null;
  return resolveRefRequired(db, key);
}
