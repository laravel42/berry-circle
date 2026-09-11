import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';

export interface SkillFile {
   path: string;
   content: string;
}

export interface SkillInput {
   name: string;
   description: string;
   content: string;
   labels: string[];
   files: SkillFile[];
}

/** A partial update; a field left undefined (or absent) keeps its value. */
export type SkillPatch = { [K in keyof SkillInput]?: SkillInput[K] | undefined };

export interface ImportedSkill extends SkillInput {
   sourceKind: 'github' | 'zip';
   sourceUrl: string | null;
   sourceRef: string | null;
}

/** An agent that carries this skill, and whether its binding is switched on. */
export interface SkillAgent {
   id: string;
   name: string;
   enabled: boolean;
}

export interface Skill {
   id: string;
   name: string;
   description: string;
   content: string;
   labels: string[];
   source: { kind: string; url: string | null; ref: string | null; importedAt: string | null };
   files: { path: string; size: number }[];
   agentEnabled: boolean | null;
   /** Who wrote or imported it; null once that account is gone. */
   createdBy: string | null;
   creatorName: string | null;
   agents: SkillAgent[];
   createdAt: string;
   updatedAt: string;
}

/** What narrows the catalogue beyond the workspace. */
export interface SkillFilter {
   query?: string | undefined;
   label?: string | undefined;
   /** Bindings for this agent decide `agentEnabled`. */
   agentId?: string | undefined;
   source?: 'manual' | 'github' | 'zip' | undefined;
   createdBy?: string | undefined;
   /** True: at least one agent has it switched on. False: no agent does. */
   inUse?: boolean | undefined;
}

export interface SkillWithFiles extends Skill {
   fileContents: SkillFile[];
}

const COLUMNS = `s.id, s.name, s.description, s.content, s.labels, s.source_kind, s.source_url,
   s.source_ref, s.imported_at, s.created_by, s.created_at, s.updated_at,
   (SELECT cu.name FROM users cu WHERE cu.id = s.created_by) AS creator_name,
   COALESCE((SELECT json_agg(json_build_object('path', f.path, 'size', octet_length(f.content))
               ORDER BY f.path)
               FROM skill_files f WHERE f.skill_id = s.id), '[]'::json) AS files,
   COALESCE((SELECT json_agg(json_build_object('id', ba.id, 'name', ba.name, 'enabled', b.enabled)
               ORDER BY ba.name)
               FROM agent_skills b
               JOIN agents ba ON ba.id = b.agent_id AND ba.archived_at IS NULL
              WHERE b.skill_id = s.id), '[]'::json) AS agents`;

export class SkillRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.#sql = sql;
      this.#newId = newId;
   }

   async list(workspaceId: string, filter: SkillFilter = {}): Promise<Skill[]> {
      const like = filter.query ? `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)},
                ${filter.agentId
                   ? this.#sql`(SELECT b.enabled FROM agent_skills b
                                 WHERE b.skill_id = s.id AND b.agent_id = ${filter.agentId})`
                   : this.#sql`NULL::boolean`} AS agent_enabled
           FROM skills s
          WHERE s.workspace_id = ${workspaceId}
            AND (${like}::text IS NULL OR s.name ILIKE ${like} OR s.description ILIKE ${like})
            AND (${filter.label ?? null}::text IS NULL OR ${filter.label ?? null} = ANY (s.labels))
            AND (${filter.source ?? null}::text IS NULL OR s.source_kind = ${filter.source ?? null})
            AND (${filter.createdBy ?? null}::uuid IS NULL OR s.created_by = ${filter.createdBy ?? null}::uuid)
            AND (${filter.inUse ?? null}::boolean IS NULL
                 OR EXISTS (SELECT 1 FROM agent_skills ub
                             JOIN agents ua ON ua.id = ub.agent_id AND ua.archived_at IS NULL
                            WHERE ub.skill_id = s.id AND ub.enabled) = ${filter.inUse ?? null}::boolean)
          ORDER BY s.name ASC
          LIMIT 500`;
      return rows.map(toSkill);
   }

   async get(workspaceId: string, id: string): Promise<SkillWithFiles> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)}, NULL::boolean AS agent_enabled
           FROM skills s WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      const files = await this.#sql`
         SELECT path, content FROM skill_files WHERE skill_id = ${id} ORDER BY path`;
      return {
         ...toSkill(row),
         fileContents: files.map((f) => ({ path: f.path as string, content: f.content as string })),
      };
   }

   async create(workspaceId: string, input: SkillInput, userId: string): Promise<SkillWithFiles> {
      const id = this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`
            INSERT INTO skills (id, workspace_id, name, description, content, labels, created_by)
            VALUES (${id}, ${workspaceId}, ${input.name}, ${input.description}, ${input.content},
                    ${input.labels}, ${userId})`.catch(classify);
         await writeFiles(tx, workspaceId, id, input.files);
      });
      return this.get(workspaceId, id);
   }

   async update(workspaceId: string, id: string, patch: SkillPatch): Promise<SkillWithFiles> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const updated = await tx`
            UPDATE skills SET
               name = COALESCE(${patch.name ?? null}, name),
               description = COALESCE(${patch.description ?? null}, description),
               content = COALESCE(${patch.content ?? null}, content),
               labels = COALESCE(${patch.labels ?? null}::text[], labels),
               updated_at = now()
             WHERE id = ${id} AND workspace_id = ${workspaceId}`.catch(classify);
         if (updated.count !== 1) throw new NotFound();
         if (patch.files) {
            await tx`DELETE FROM skill_files WHERE skill_id = ${id}`;
            await writeFiles(tx, workspaceId, id, patch.files);
         }
      });
      return this.get(workspaceId, id);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const deleted = await this.#sql`
         DELETE FROM skills WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   /** An import creates the skill, or (refresh) replaces an existing one wholesale. */
   async replaceFromImport(
      workspaceId: string,
      id: string | null,
      imported: ImportedSkill,
      userId: string
   ): Promise<SkillWithFiles> {
      const target = id ?? this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         if (id === null) {
            await tx`
               INSERT INTO skills (id, workspace_id, name, description, content, labels,
                                   source_kind, source_url, source_ref, imported_at, created_by)
               VALUES (${target}, ${workspaceId}, ${imported.name}, ${imported.description},
                       ${imported.content}, ${imported.labels}, ${imported.sourceKind},
                       ${imported.sourceUrl}, ${imported.sourceRef}, now(), ${userId})`.catch(classify);
         } else {
            const updated = await tx`
               UPDATE skills SET description = ${imported.description}, content = ${imported.content},
                      source_ref = ${imported.sourceRef}, imported_at = now(), updated_at = now()
                WHERE id = ${id} AND workspace_id = ${workspaceId}`;
            if (updated.count !== 1) throw new NotFound();
            await tx`DELETE FROM skill_files WHERE skill_id = ${id}`;
         }
         await writeFiles(tx, workspaceId, target, imported.files);
      });
      return this.get(workspaceId, target);
   }

   async setBinding(workspaceId: string, agentId: string, skillId: string, enabled: boolean): Promise<void> {
      await this.#sql`
         INSERT INTO agent_skills (agent_id, skill_id, workspace_id, enabled)
         VALUES (${agentId}, ${skillId}, ${workspaceId}, ${enabled})
         ON CONFLICT (agent_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled`.catch(classify);
   }

   async removeBinding(workspaceId: string, agentId: string, skillId: string): Promise<void> {
      // NotFound when nothing matched, so another workspace's binding answers
      // 404 like every other cross-tenant write, not a silent 204.
      const deleted = await this.#sql`
         DELETE FROM agent_skills
          WHERE agent_id = ${agentId} AND skill_id = ${skillId} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   /** Used by agent copy (Task 5), inside the copy's transaction. */
   static async copyBindings(tx: Queryable, fromAgentId: string, toAgentId: string): Promise<void> {
      await tx`
         INSERT INTO agent_skills (agent_id, skill_id, workspace_id, enabled)
         SELECT ${toAgentId}, skill_id, workspace_id, enabled FROM agent_skills
          WHERE agent_id = ${fromAgentId}`;
   }

   async enabledForAgent(workspaceId: string, agentId: string): Promise<SkillWithFiles[]> {
      const rows = await this.#sql`
         SELECT s.id FROM skills s
           JOIN agent_skills b ON b.skill_id = s.id AND b.enabled
          WHERE b.agent_id = ${agentId} AND s.workspace_id = ${workspaceId}
          ORDER BY s.name`;
      return Promise.all(rows.map((row) => this.get(workspaceId, row.id as string)));
   }
}

async function writeFiles(tx: Sql, workspaceId: string, skillId: string, files: SkillFile[]): Promise<void> {
   for (const file of files) {
      await tx`
         INSERT INTO skill_files (skill_id, workspace_id, path, content)
         VALUES (${skillId}, ${workspaceId}, ${file.path}, ${file.content})`.catch(classify);
   }
}

function toSkill(row: Record<string, unknown>): Skill {
   return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      content: row.content as string,
      labels: (row.labels as string[] | null) ?? [],
      source: {
         kind: row.source_kind as string,
         url: (row.source_url as string | null) ?? null,
         ref: (row.source_ref as string | null) ?? null,
         importedAt: toRFC3339(row.imported_at as string | null),
      },
      files: (row.files as { path: string; size: number }[] | null) ?? [],
      agentEnabled: (row.agent_enabled as boolean | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      creatorName: (row.creator_name as string | null) ?? null,
      agents: (row.agents as SkillAgent[] | null) ?? [],
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/** Unique name → Conflict; a foreign key into another workspace → NotFound. */
function classify(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503' || code === '23514') throw new NotFound();
   throw error;
}
