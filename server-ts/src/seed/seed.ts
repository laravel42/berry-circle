import { hashPassword } from '../auth/password.ts';
import type { Sql } from '../db/pool.ts';
import { withinTx } from '../db/pool.ts';
import {
   AgentModelName,
   AgentModelProvider,
   TextToSpeechAgentID,
   TextToVideoAgentID,
   BoardID,
   BoardName,
   BoardSlug,
   UserEmail,
   UserID,
   UserName,
   UserPassword,
   WorkspaceID,
   WorkspaceName,
   WorkspaceSlug,
} from './ids.ts';

/**
 * The local development dataset.
 *
 * Every step is idempotent, so the command is safe to run after migrations on
 * every boot. The fixed ids are what make that true: a second run updates the
 * same rows rather than creating a second workspace nobody asked for.
 */
export interface SeedOptions {
   /**
    * Whether the demo tasks and projects are written. On by default, so a
    * clean volume has something to look at; off for a developer who wants
    * the identity, workspace and board but an empty product to work in —
    * and who does not want the demo rows coming back on every boot after
    * deleting them.
    */
   demoWork?: boolean;
}

export async function apply(
   sql: Sql,
   now: string = new Date().toISOString(),
   options: SeedOptions = {}
): Promise<void> {
   await withinTx(sql, async (tx) => {
      await upsertUser(tx, now);
      await setUserPassword(tx, now);
      await upsertWorkspace(tx, now);
      await upsertMembership(tx, now);
      await setUserLastWorkspace(tx, now);
      await upsertBoard(tx, now);
      await upsertMediaAgents(tx, now);
      if (options.demoWork ?? true) {
         await upsertIssues(tx, now);
         await upsertProjects(tx, now);
      }
      await assignAgentModels(tx, now);
   });
}

/**
 * Gives the workspace's agents a model to run on.
 *
 * Berry does not create agents here — a trigger inserts the protected
 * Orchestrator when the workspace appears, and it inserts it with no model. The
 * effect in a fresh environment is an agent that exists, can be assigned an
 * issue, and then cannot run, because the picker shows no model and nothing
 * chose one. This closes that gap for local development.
 *
 * Only rows with no model are touched. An agent someone deliberately pointed at
 * a different model keeps it: a seed that runs on every boot must not quietly
 * undo a choice a developer made, and `COALESCE` in a single statement would do
 * exactly that on the next run.
 */
/**
 * The two media agents, on the models that suit the work.
 *
 * Neither renders with its own model. A text-to-speech or text-to-video agent
 * is a chat model that writes the script and calls a tool — Polly, or Nova
 * Reel — that renders it; the rendering models are not chat models and cannot
 * drive the loop. So the choice here is which model writes best for the
 * medium. Narration is prose that has to sound right read aloud, and Claude
 * Sonnet writes it markedly better than Haiku — 4.6 rather than 4.5, because
 * 4.5 sits behind a Marketplace subscription this account does not hold and
 * fails with INVALID_PAYMENT_INSTRUMENT, while 4.6 invokes directly. A video prompt is a dense
 * visual description in the vocabulary Nova Reel was trained beside, and Nova
 * Pro is the family's own chat model, which Amazon recommends for writing
 * Reel prompts. Both are upserted with fixed ids, so a re-seed updates the
 * instructions rather than creating a second copy.
 */
const MEDIA_AGENTS = [
   {
      id: TextToSpeechAgentID,
      name: 'text-to-speech',
      description: 'Turns text into narrated audio: writes the script for the ear, then renders it with Amazon Polly.',
      model: 'us.anthropic.claude-sonnet-4-6',
      capabilities: ['text_to_speech', 'file_list', 'file_read', 'file_write'],
      instructions: `You produce spoken audio from text.

First write the script for the ear, not the eye: short sentences, no
headings or bullet marks, numbers and abbreviations spelled the way they are
said, and pauses where a listener needs them. Then render it with
generate_speech, choosing a voice that fits the content (Joanna or Matthew
for neutral narration; ask for another only when the task names one). One
call takes at most 3000 characters, so split a longer script into numbered
parts — narration/part-01.mp3, narration/part-02.mp3 — and render each.

Save the script itself beside the audio as a text file, so a person can read
what was said. Your final message lists the files you produced and their
durations in words.`,
   },
   {
      id: TextToVideoAgentID,
      name: 'text-to-video',
      description:
         'Turns a description into a finished short video: writes the shot prompts, renders them with Amazon Nova Reel, narrates with Amazon Polly and cuts it together with ffmpeg.',
      // Sonnet rather than Nova Pro: the model here plans and drives four
      // tools in sequence, and Nova Pro leaked its reasoning into the task
      // and gave up at the first missing file. The media models are the
      // tools, not the agent.
      model: 'us.anthropic.claude-sonnet-4-6',
      capabilities: ['text_to_video', 'text_to_speech', 'video_editing', 'file_list', 'file_read', 'file_write'],
      instructions: `You produce short videos from a description, finished and ready to watch.

Shots. A rendered clip is six seconds, so plan in shots: break the request
into a sequence of shots that each show one thing, and write one prompt per
shot. A good prompt is a dense visual description under 512 characters —
subject, setting, camera motion, lighting, style — never a story or a list
of instructions. Render each with generate_video at a path like
clips/01-opening.mp4. Rendering takes a few minutes per clip; do not start
more than four clips on one task without being asked.

Voice. When the task wants narration or a voiceover, write the script for
the ear — short sentences, spoken numbers, a pause where a listener needs
one — and render it with generate_speech to audio/narration.mp3 (Joanna or
Matthew unless the task names a voice). Keep the script to what fits the
picture: about fifteen words per six-second shot.

Cut. Every file saved on this task is in your workspace at the path
list_files shows, and ffmpeg is installed. Join clips with the concat
demuxer (a list file of "file 'clips/01-opening.mp4'" lines, then
ffmpeg -f concat -safe 0 -i list.txt -c copy video/joined.mp4). Lay the
narration over the picture with
ffmpeg -i video/joined.mp4 -i audio/narration.mp3 -c:v copy -c:a aac -shortest video/final.mp4
— and if the narration runs longer than the picture, hold the last frame
with -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=<seconds>[v]" -map "[v]" -map 1:a
instead of cutting it short. Check the result with ffprobe before you hand
it in. A file a command produces exists only in the workspace: save it on
the task with collect_file, or it is lost when the run ends.

Hand in. Save the shot list and the narration script as text files beside
the media so a person can read what each shot and line was meant to be.
Your final message names the finished file first, then the clips and audio
it was cut from, with their durations in words. Do not include your
reasoning in the message; it is posted on the task as your report.`,
   },
] as const;

async function upsertMediaAgents(tx: Sql, now: string): Promise<void> {
   for (const agent of MEDIA_AGENTS) {
      await tx`
         INSERT INTO agents (
            id, workspace_id, board_id, name, description, status, capabilities,
            instructions, model_provider, model_name, created_at, updated_at
         ) VALUES (
            ${agent.id}, ${WorkspaceID}, ${BoardID}, ${agent.name}, ${agent.description}, 'available',
            ${[...agent.capabilities]}, ${agent.instructions}, ${AgentModelProvider}, ${agent.model},
            ${now}, ${now}
         )
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            capabilities = EXCLUDED.capabilities,
            instructions = EXCLUDED.instructions,
            model_provider = EXCLUDED.model_provider,
            model_name = EXCLUDED.model_name,
            archived_at = NULL,
            updated_at = EXCLUDED.updated_at
      `;
   }
}

async function assignAgentModels(tx: Sql, now: string): Promise<void> {
   await tx`
      UPDATE agents
         SET model_provider = ${AgentModelProvider},
             model_name = ${AgentModelName},
             updated_at = ${now}
       WHERE workspace_id = ${WorkspaceID}
         AND archived_at IS NULL
         AND (model_provider IS NULL OR model_name IS NULL)
   `;
}

async function upsertUser(tx: Sql, now: string): Promise<void> {
   // A different user already holding this email would fail the unique index
   // below. Renaming theirs is deliberate: this is a development fixture, and
   // the seeded identity is the one the login flow expects to find.
   await tx`
      UPDATE users
         SET email = 'replaced-' || id::text || '@berry.test'
       WHERE lower(email) = lower(${UserEmail})
         AND id <> ${UserID}
   `;
   await tx`
      INSERT INTO users (
         id, email, name, role, settings, onboarding_state,
         onboarding_completed_at, last_workspace_id, created_at, updated_at
      ) VALUES (
         ${UserID}, ${UserEmail}, ${UserName}, 'admin',
         '{"theme":"system","timezone":"UTC","reducedMotion":false}'::jsonb,
         '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
         ${now}, NULL, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at
   `;
}

async function setUserPassword(tx: Sql, now: string): Promise<void> {
   // Set a real scrypt credential so the seeded identity can sign in through the
   // password flow (passwordless login is off unless APP_ENV is development/test
   // and the flag is on). Uses the same hashPassword the sign-up path uses, so
   // the stored salt (16 bytes) and hash (32 bytes) satisfy migration 050's
   // length constraints. Rewritten on every seed run, which is harmless.
   const { salt, hash } = await hashPassword(UserPassword);
   await tx`
      UPDATE users
         SET password_hash = ${hash},
             password_salt = ${salt},
             password_updated_at = ${now},
             updated_at = ${now}
       WHERE id = ${UserID}
   `;
}

async function setUserLastWorkspace(tx: Sql, now: string): Promise<void> {
   // Set after the workspace exists: the column is a foreign key, so the
   // insert above has to leave it NULL.
   await tx`
      UPDATE users
         SET last_workspace_id = ${WorkspaceID}, updated_at = ${now}
       WHERE id = ${UserID}
   `;
}

async function upsertWorkspace(tx: Sql, now: string): Promise<void> {
   await tx`
      UPDATE workspaces
         SET slug = 'replaced-' || id::text
       WHERE lower(slug) = lower(${WorkspaceSlug})
         AND id <> ${WorkspaceID}
         AND deleted_at IS NULL
   `;
   await tx`
      INSERT INTO workspaces (
         id, name, slug, description, settings, created_by, created_at, updated_at
      ) VALUES (
         ${WorkspaceID}, ${WorkspaceName}, ${WorkspaceSlug}, 'Local Berry workspace',
         '{"issuePrefix":"BER","defaultRole":"member","allowMemberInvites":false}'::jsonb,
         ${UserID}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at
   `;
}

async function upsertMembership(tx: Sql, now: string): Promise<void> {
   await tx`
      INSERT INTO workspace_memberships (
         workspace_id, user_id, role, joined_at, updated_at
      ) VALUES (${WorkspaceID}, ${UserID}, 'owner', ${now}, ${now})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at
   `;
}

async function upsertBoard(tx: Sql, now: string): Promise<void> {
   await tx`
      UPDATE boards
         SET slug = 'replaced-' || id::text
       WHERE lower(slug) = lower(${BoardSlug})
         AND id <> ${BoardID}
   `;
   await tx`
      INSERT INTO boards (
         id, workspace_id, name, slug, description, columns, issue_counter,
         created_by, created_at, updated_at
      ) VALUES (
         ${BoardID}, ${WorkspaceID}, ${BoardName}, ${BoardSlug},
         'Default development crew board', '[]'::jsonb, 3,
         ${UserID}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at
   `;
}

const ISSUES = [
   {
      id: '11111111-1111-4111-8111-111111111201',
      number: 1,
      title: 'Wire agent runtime probes',
      status: 'todo',
      priority: 'high',
      sort: 1000,
   },
   {
      id: '11111111-1111-4111-8111-111111111202',
      number: 2,
      title: 'Match projects board to issues Kanban',
      status: 'in_progress',
      priority: 'medium',
      sort: 2000,
   },
   {
      id: '11111111-1111-4111-8111-111111111203',
      number: 3,
      title: 'Seed local development data',
      status: 'done',
      priority: 'low',
      sort: 3000,
   },
] as const;

async function upsertIssues(tx: Sql, now: string): Promise<void> {
   for (const issue of ISSUES) {
      await tx`
         INSERT INTO issues (
            id, board_id, number, title, description, status, priority, sort_order,
            created_by, created_at, updated_at
         ) VALUES (
            ${issue.id}, ${BoardID}, ${issue.number}, ${issue.title},
            'Seeded for local Berry development.',
            ${issue.status}::issue_status, ${issue.priority}::issue_priority, ${issue.sort},
            ${UserID}, ${now}, ${now}
         )
         ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            sort_order = EXCLUDED.sort_order,
            updated_at = EXCLUDED.updated_at
      `;
   }
}

const PROJECTS = [
   {
      id: '11111111-1111-4111-8111-111111111301',
      name: 'Agent runtime',
      status: 'active',
      priority: 'high',
   },
   {
      id: '11111111-1111-4111-8111-111111111302',
      name: 'Projects parity',
      status: 'planned',
      priority: 'medium',
   },
   {
      id: '11111111-1111-4111-8111-111111111303',
      name: 'Workspace bootstrap',
      status: 'completed',
      priority: 'low',
   },
] as const;

async function upsertProjects(tx: Sql, now: string): Promise<void> {
   for (const project of PROJECTS) {
      await tx`
         INSERT INTO projects (
            id, workspace_id, name, description, status, priority,
            start_date, target_date, created_by, created_at, updated_at
         ) VALUES (
            ${project.id}, ${WorkspaceID}, ${project.name},
            'Seeded for local Berry development.',
            ${project.status}, ${project.priority},
            CURRENT_DATE - 7, CURRENT_DATE + 21, ${UserID}, ${now}, ${now}
         )
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            updated_at = EXCLUDED.updated_at
      `;
   }
}
