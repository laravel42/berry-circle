import { z } from 'zod';

/**
 * Everything a runtime needs to work one task, in one JSON body.
 *
 * Shipped in the runtime image; imports nothing but zod. It carries secrets —
 * the task token, a git credential, sealed-then-opened profile env — which is
 * why it travels only over the AWS SDK (or the local runtime's loopback) and
 * why anything that logs it must log `redactEnvelope(envelope)` instead.
 */

export const transcriptMessageSchema = z.object({
   role: z.enum(['user', 'assistant']),
   text: z.string(),
});

export const repoPlanSchema = z.object({
   /** `owner/name` on GitHub. */
   fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
   branch: z.string().min(1),
   baseBranch: z.string().min(1),
   credential: z.object({ username: z.string(), password: z.string() }),
   verifyCommands: z.array(z.string()),
   issueReference: z.string(),
   issueTitle: z.string(),
});

export const skillRefSchema = z.object({
   name: z.string().min(1),
   files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});

export const mcpServerRefSchema = z.object({
   name: z.string().min(1),
   url: z.url(),
   transport: z.enum(['http', 'sse']),
   headers: z.record(z.string(), z.string()),
});

export const taskEnvelopeSchema = z.object({
   kind: z.enum(['agent', 'completion']),
   runId: z.string().min(1),
   /** Human-readable `(agent, issue)` / `(agent, chat)` / `completion:<run>` key. */
   sessionKey: z.string().min(1),
   /** AgentCore requires at least 33 characters. */
   runtimeSessionId: z.string().min(33).max(100),
   agent: z.object({
      name: z.string().min(1),
      instructions: z.string(),
      model: z.string().min(1),
      skills: z.array(skillRefSchema),
      mcpServers: z.array(mcpServerRefSchema),
      permissions: z.array(z.string()),
      maxTokens: z.number().int().positive().nullable(),
      temperature: z.number().nullable(),
   }),
   task: z.object({
      /** The full first user message, already built by the server. */
      prompt: z.string(),
      issue: z
         .object({
            id: z.string(),
            identifier: z.string(),
            title: z.string(),
            description: z.string().nullable(),
         })
         .nullable(),
      comments: z.array(z.object({ author: z.string(), body: z.string(), createdAt: z.string() })),
      dependencies: z.array(
         z.object({
            identifier: z.string(),
            title: z.string(),
            status: z.string(),
            direction: z.enum(['depends_on', 'blocks']),
         })
      ),
      projectResources: z.array(
         z.object({ title: z.string(), url: z.string().nullable(), content: z.string().nullable() })
      ),
      priorWork: z.string().nullable(),
   }),
   /** The prior conversation for this session, oldest first; used only on a cold start. */
   transcript: z.array(transcriptMessageSchema),
   repo: repoPlanSchema.nullable(),
   completion: z
      .object({
         system: z.string(),
         /** `z.toJSONSchema(schema)` of the answer, or null for free text. */
         jsonSchema: z.record(z.string(), z.unknown()).nullable(),
      })
      .nullable(),
   env: z.record(z.string(), z.string()),
   berry: z.object({ apiUrl: z.url(), token: z.string().min(1) }),
});

export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type RepoPlan = z.infer<typeof repoPlanSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type McpServerRef = z.infer<typeof mcpServerRefSchema>;

const REDACTED = '[redacted]';

/** The envelope as it may be logged: every secret replaced, shape kept. */
export function redactEnvelope(envelope: TaskEnvelope): unknown {
   return {
      ...envelope,
      env: Object.fromEntries(Object.keys(envelope.env).map((key) => [key, REDACTED])),
      berry: { apiUrl: envelope.berry.apiUrl, token: REDACTED },
      repo: envelope.repo
         ? { ...envelope.repo, credential: { username: envelope.repo.credential.username, password: REDACTED } }
         : null,
      agent: {
         ...envelope.agent,
         mcpServers: envelope.agent.mcpServers.map((server) => ({
            ...server,
            headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, REDACTED])),
         })),
      },
   };
}
