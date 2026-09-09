import { serve } from '@hono/node-server';

/**
 * The build, for `berry_build_info` and nothing else.
 *
 * Read from the environment rather than from `package.json`: a container built
 * from a commit knows which commit it was, and the manifest's version only
 * changes when someone remembers to change it.
 */
const VERSION = (process.env.BERRY_VERSION ?? '').trim() || '0.1.0-dev';

import { loadConfig } from './config/config.ts';
import { checkDatabase, closeDatabase, openDatabase } from './db/pool.ts';
import { createApp } from './http/app.ts';
import { Registry } from './http/registry.ts';
import { platformMounts } from './mounts/platform.ts';
import { authMounts } from './mounts/auth.ts';
import { meMounts } from './mounts/me.ts';
import { workspaceMounts } from './mounts/workspaces.ts';
import { secretsMounts } from './mounts/secrets.ts';
import { boardMounts } from './mounts/boards.ts';
import { issueMounts } from './mounts/issues.ts';
import { commentMounts, issueCommentRoutes } from './mounts/comments.ts';
import { issueRelationRoutes } from './mounts/issue-relations.ts';
import { issueAttachmentRoutes } from './mounts/issue-attachments.ts';
import { goalMounts } from './mounts/goals.ts';
import { attachmentMounts } from './mounts/attachments.ts';
import { projectMounts } from './mounts/projects.ts';
import { boardRunRoutes, issueRunRoutes, runMounts } from './mounts/runs.ts';
import { integrationMounts } from './mounts/integrations.ts';
import { PlanTriage } from './plans/triage.ts';
import { GitHubProvider } from './scm/github-provider.ts';
import { startGateway } from './agentcore/bootstrap.ts';
import { ScmLinkRepository } from './scm/links.ts';
import { ScmProvisioning } from './scm/provisioning.ts';
import { ScmWorkspaces } from './scm/workspaces.ts';
import { ScmSync } from './scm/sync.ts';
import { ScmInbound } from './scm/inbound.ts';
import { WebhookDeliveries } from './scm/webhook.ts';
import { webhookMounts } from './mounts/webhooks.ts';
import { approvalMounts } from './mounts/approvals.ts';
import { inboxMounts } from './mounts/inbox.ts';
import { workspaceReadMounts } from './mounts/workspace-reads.ts';
import { accountRoutes } from './mounts/account.ts';
import { conversationMounts } from './mounts/conversations.ts';
import { editorMounts } from './mounts/editor.ts';
import { EditorAssist } from './editor/assist.ts';
import { planMounts } from './mounts/plans.ts';
import { PlanAnswerRepository } from './plans/answers.ts';
import { PlanRepository } from './plans/repository.ts';
import { PlanGenerator } from './plans/generator.ts';
import { ConversationRepository } from './conversations/repository.ts';
import { ConversationResponder } from './conversations/responder.ts';
import { InboxRepository } from './inbox/repository.ts';
import { ApprovalRepository } from './approvals/repository.ts';
import { OAuthStateStore } from './integrations/oauth.ts';
import { RunRepository } from './runs/repository.ts';
import { RunLedger } from './runs/ledger.ts';
import { Dispatcher } from './runs/dispatcher.ts';
import { agentMounts } from './mounts/agents.ts';
import { eventMounts } from './mounts/events.ts';
import { IdentityRepository } from './identity/repository.ts';
import { WorkspaceRepository } from './identity/workspaces.ts';
import { SecretsRepository } from './identity/secrets.ts';
import { BoardRepository } from './core/boards.ts';
import { IssueRepository } from './core/issues.ts';
import { CommentRepository } from './core/comments.ts';
import { DependencyRepository } from './core/dependencies.ts';
import { ReviewRepository } from './core/reviews.ts';
import { GoalRepository } from './core/goals.ts';
import { AttachmentRepository } from './core/attachments.ts';
import { ProjectRepository } from './core/projects.ts';
import { Hub } from './realtime/hub.ts';
import { Distributed } from './realtime/distributed.ts';
import { ReplayRepository } from './realtime/replay.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { SessionService } from './auth/sessions.ts';
import { Storage } from './storage/storage.ts';
import { AdkExecutor } from './agents/executor.ts';
import { AgentRepository } from './agents/repository.ts';
import { ModelCatalog } from './agents/catalog.ts';
import { createLogger } from './observability/log.ts';
import { createExecutionDriver } from './execution/factory.ts';
import { ConnectionRepository } from './integrations/connections.ts';
import { GitHubAppRepository } from './integrations/github-app.ts';
import { sealerFromKey } from './integrations/sealing.ts';

/**
 * The composition root.
 *
 * Domain modules contribute mounts and this file is the only place that knows
 * about all of them, which is why no module imports every handler.
 */

const config = loadConfig();
const logger = createLogger(config.serviceName);
const sql = openDatabase({ url: config.databaseUrl });

const sessions = new SessionService({
   sql,
   sessionTtlMs: config.sessionTtlMs,
});

const identity = new IdentityRepository(sql);
const workspaces = new WorkspaceRepository(sql);
const secrets = new SecretsRepository(sql);
const boards = new BoardRepository(sql);
const issues = new IssueRepository(sql);
const comments = new CommentRepository(sql);
const dependencies = new DependencyRepository(sql);
const reviews = new ReviewRepository(sql);
const goals = new GoalRepository(sql);
const attachments = new AttachmentRepository(sql);
const projects = new ProjectRepository(sql);
const agents = new AgentRepository(sql);

// A hub with no relay for now: this process delivers to its own subscribers.
// The Valkey relay is wired when the SSE endpoints land, so a subscriber
// exists to receive what other nodes publish.
const broadcaster = new Distributed(new Hub(config.realtimeBuffer), null);
const idempotency = new IdempotencyStore(sql);

/**
 * The agent runtime, present only when this server can actually run one.
 *
 * Both halves are required and neither has a safe default: without a model
 * credential there is nothing to call, and without object storage an agent's
 * files would have nowhere to land — a run that produced work and dropped it
 * is worse than one that never started.
 */
const storage = config.storage
   ? new Storage({
        bucket: config.storage.bucket,
        region: config.storage.region,
        ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
        forcePathStyle: config.storage.forcePathStyle,
        ...(config.storage.accessKeyId ? { accessKeyId: config.storage.accessKeyId } : {}),
        ...(config.storage.secretAccessKey
           ? { secretAccessKey: config.storage.secretAccessKey }
           : {}),
        ...(config.storage.sessionToken ? { sessionToken: config.storage.sessionToken } : {}),
        maxBytes: config.storage.maxBytes,
     })
   : null;

/**
 * Where an agent's commands run.
 *
 * Constructed even when nothing is configured — the unconfigured driver
 * refuses every call with a message naming what is missing, which is a better
 * failure than a null that reaches a call site expecting a driver.
 */
const execution = createExecutionDriver(config.execution, config.agentCore);

/**
 * Provider connections, when a key exists to open them with.
 *
 * Null rather than a repository that cannot decrypt: a run then simply never
 * gets a repository, which is a working deployment, instead of one that fails
 * at the clone with a decryption error.
 */
const scmLinks = new ScmLinkRepository(sql);
let scm: ScmProvisioning | null = null;
let scmWorkspaces: ScmWorkspaces | null = null;
let scmSync: ScmSync | null = null;

/**
 * The issue mount's view of goals.
 *
 * `GoalLinker` was declared with a shape no repository implemented, so
 * `goalId` on an issue has been accepted and silently discarded. This adapts
 * the repository that does exist rather than changing its signature, which
 * several other callers depend on.
 */
const goalLinker = {
   async clearIssueGoal(issueId: string): Promise<void> {
      await sql`DELETE FROM goal_issues WHERE issue_id = ${issueId}`;
   },
   async linkIssue(
      workspaceId: string,
      goalId: string,
      issueId: string,
      actorId: string
   ): Promise<boolean> {
      // Scoped here rather than trusted: a goal from another workspace must
      // read as missing, not be linked across the boundary.
      const [goal] = await sql`
         SELECT id FROM goals
          WHERE id = ${goalId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
      if (!goal) return false;
      await goals.linkIssue({
         workspaceId,
         goalId,
         issueId,
         actorId,
         now: new Date().toISOString(),
      });
      return true;
   },
};
const scmInbound = new ScmInbound({ sql, links: scmLinks, logger });

const connections = config.integrationKey
   ? new ConnectionRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

// The App's own credentials are sealed with the same key, for the same reason:
// a deployment that cannot seal cannot hold a private key either.
const githubApp = config.integrationKey
   ? new GitHubAppRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

/**
 * The git host, which is GitHub.
 *
 * Constructed here rather than above because the credential is a GitHub App
 * installation token, and the App repository is what mints one — per
 * workspace, which is why the provider is a factory rather than an instance.
 */
/**
 * The source-control provider.
 *
 * `agentcore` reaches GitHub through the gateway's tools; `legacy` uses
 * Berry's own client and GitHub App. Both satisfy `ScmProvider`, so nothing in
 * the domain can tell — which is what makes the switch a rollback rather than
 * a revert.
 *
 * Discovery runs at boot, so a gateway missing a required tool is found while
 * somebody is watching rather than an hour later when a plan compiles.
 */
let gitCredential: (workspaceId: string) => Promise<{ username: string; password: string }> = async () => {
   throw new Error('no GitHub credential is configured');
};

if (config.githubProvider === 'agentcore' && config.agentCoreGateway) {
   const started = await startGateway(config.agentCoreGateway, logger);
   if (started.provider) {
      const provider = started.provider;
      scm = new ScmProvisioning({
         provider: () => provider,
         providerId: 'github',
         links: scmLinks,
         logger,
      });
      scmWorkspaces = new ScmWorkspaces(sql, scm);
      scmSync = new ScmSync(sql, scm, logger);
      gitCredential = () => started.identity.gitCredential();
   }
} else if (githubApp) {
   const app = githubApp;
   scm = new ScmProvisioning({
      provider: (workspaceId: string) =>
         new GitHubProvider({ token: () => app.token(workspaceId) }),
      providerId: 'github',
      links: scmLinks,
      logger,
   });
   scmWorkspaces = new ScmWorkspaces(sql, scm);
   scmSync = new ScmSync(sql, scm, logger);
   gitCredential = (workspaceId: string) =>
      app.token(workspaceId).then((password) => ({ username: 'x-access-token', password }));
}

const executor =
   config.agents && storage
      ? new AdkExecutor({
           sql,
           storage,
           region: config.agents.region,
           ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
           defaultModel: config.agents.defaultModel,
           // Only when one is actually configured. Handing over the
           // unconfigured driver would give agents a `run_command` that
           // refuses every call, and an agent cannot work around a tool it was
           // told it has.
           ...(config.execution ? { execution } : {}),
           ...(connections ? { connections } : {}),
           ...(githubApp ? { githubApp } : {}),
           gitCredential,
        })
      : null;

// The model picker's catalogue. Null without a credential rather than an
// empty list: "no models exist" and "this server cannot ask" are different
// answers, and only one of them is true.
const modelCatalog = config.agents
   ? new ModelCatalog({
        region: config.agents.region,
        ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
     })
   : null;

// Reading the ledger, and admitting a run. The executor builds its own ledger
// per run because it writes as the run happens; this one is for the request
// path, which only reads and cancels.
const runOptions = {
   sessions,
   runs: new RunRepository(sql),
   ledger: new RunLedger({ sql }),
   issues,
   boards,
   idempotency,
};

const registry = new Registry();
registry.registerAll(meMounts({ sessions, identity, nested: accountRoutes({ boards, sql }) }));
registry.registerAll(workspaceMounts({ sessions, workspaces, secrets }));
registry.registerAll(secretsMounts({ sessions, secrets }));
registry.registerAll(
   boardMounts({ sessions, boards, idempotency, nested: boardRunRoutes(runOptions) })
);
const commentOptions = { sessions, comments, issues, idempotency, broadcaster };
registry.registerAll(
   issueMounts({
      scm: scmSync,
      // Without this, `goalId` on a create or patch is accepted and silently
      // does nothing — and a task then reaches the git host with no milestone.
      goals: goalLinker,
      sessions,
      issues,
      boards,
      idempotency,
      broadcaster,
      nested: issueCommentRoutes(commentOptions),
      relations: issueRelationRoutes({ issues, dependencies, reviews }),
      runs: issueRunRoutes(runOptions),
      attachments: issueAttachmentRoutes({
         attachments,
         issues,
         storage,
         // Without storage there is no cap to enforce, because there is
         // nowhere to put a file; the route answers 503 before it reads one.
         maxBytes: config.storage?.maxBytes ?? 0,
      }),
   })
);
registry.registerAll(commentMounts(commentOptions));
registry.registerAll(
   webhookMounts({
      inbound: scmInbound,
      deliveries: new WebhookDeliveries(sql),
      secret: config.git?.webhookSecret ?? null,
      logger,
   })
);
registry.registerAll(
   goalMounts({ sessions, goals, issues, idempotency, broadcaster, scm: scmSync })
);
registry.registerAll(attachmentMounts({ sessions, attachments, storage }));
registry.registerAll(projectMounts({ sessions, projects, idempotency, scm, scmWorkspaces, logger }));
registry.registerAll(runMounts(runOptions));
registry.registerAll(inboxMounts({ sessions, inbox: new InboxRepository(sql), boards }));
registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
registry.registerAll(
   planMounts({
      sessions,
      plans: new PlanRepository(sql),
      answers: new PlanAnswerRepository(sql),
      // Reading a plan works without a model credential; only generating one
      // needs it, and a null generator answers PLANNER_UNAVAILABLE rather
      // than opening a plan nothing will ever fill in.
      generator: config.agents
         ? new PlanGenerator({
              sql,
              region: config.agents.region,
              ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
              defaultModel: config.agents.defaultModel,
              maxRepairs: config.agents.maxRepairs,
              maxCriticRounds: config.agents.maxCriticRounds,
           })
         : null,
      // Routing needs the same credential planning does: it is the
      // orchestrator reading the roster and deciding, not a lookup table.
      triage: config.agents
         ? new PlanTriage({
              sql,
              region: config.agents.region,
              ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
              defaultModel: config.agents.defaultModel,
           })
         : null,
      // Its own repository rather than the request path's: a routed task is
      // admitted outside any request, after the response has gone.
      runs: new RunRepository(sql),
      boards,
      idempotency,
      sql,
      logger,
   })
);
registry.registerAll(
   conversationMounts({
      sessions,
      conversations: new ConversationRepository(sql),
      boards,
      sql,
      // Reading a thread works without a model credential; only answering
      // needs one, and a null responder says so rather than failing the turn.
      responder: config.agents
         ? new ConversationResponder({
              sql,
              region: config.agents.region,
              ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
              defaultModel: config.agents.defaultModel,
           })
         : null,
   })
);
registry.registerAll(
   editorMounts({
      sessions,
      assist: config.agents
         ? new EditorAssist({
              region: config.agents.region,
              ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
              defaultModel: config.agents.defaultModel,
           })
         : null,
   })
);
registry.registerAll(
   approvalMounts({
      sessions,
      approvals: new ApprovalRepository(sql),
      boards,
      issues,
      idempotency,
   })
);
registry.registerAll(
   integrationMounts({
      sessions,
      boards,
      connections,
      // The state store needs no key of its own — it holds a hash, not a
      // secret — but a deployment that cannot seal a token cannot finish a
      // handshake either, so the two travel together.
      states: connections ? new OAuthStateStore({ sql }) : null,
      github: config.integrations.github,
      githubApp,
      publicUrl: config.integrations.publicUrl,
      appUrl: config.integrations.appUrl,
   })
);
registry.registerAll(agentMounts({ sessions, agents, idempotency, catalog: modelCatalog, logger }));
registry.registerAll(
   eventMounts({ sessions, replay: new ReplayRepository(sql), boards, broadcaster })
);
registry.registerAll(
   authMounts({
      sessions,
      identity,
      sql,
      login: {
         allowKnownEmail: config.allowPasswordlessLogin,
         environment: config.appEnv,
      },
   })
);
registry.registerAll(
   platformMounts({
      database: () => checkDatabase(sql),
      metrics: {
         sql,
         // Null rather than zero on a server that does not dispatch: "this
         // process runs no runs" and "this process is running none right now"
         // are different facts, and a zero would read as the second.
         inflight: () => dispatcher?.inflight ?? null,
         version: VERSION,
      },
      capabilities: {
         // Reported by whichever server answers, so they have to agree. Only
         // what this process can actually do is true; the rest arrive with the
         // mounts that provide them.
         // True only when a model credential and object storage are both
         // present: this is what the browser uses to decide whether running
         // an agent is offered at all.
         // A model credential and object storage, which is what an agent
         // needs to run at all. Not the dispatcher: a deployment could split
         // serving from dispatching, and this is reported by whichever server
         // answers — so it has to be a property of the build and its
         // configuration rather than of which process was asked.
         agentExecution: executor !== null,
         metrics: true,
         // The event streams are served here now. The relay is not wired, so
         // a fact published by another process arrives on the next poll
         // rather than instantly — later, never lost, because the stream
         // replays from PostgreSQL and Valkey only ever wakes it.
         realtime: true,
         storage: storage !== null,
         valkey: false,
         // The planner runs when there is a model credential to run it with.
         planner: config.agents !== null,
      },
   })
);

/**
 * What turns a queued run into a running one.
 *
 * Only where there is an executor: a server with no model credential can serve
 * the ledger and admit runs, and a dispatcher there would claim work it cannot
 * do and fail every run it touched.
 */
const dispatcher =
   executor && config.agents
      ? new Dispatcher({
           sql,
           executor,
           logger,
           concurrency: config.agents.concurrency,
        })
      : null;
dispatcher?.start();

const app = createApp(registry);

const server = serve({ fetch: app.fetch, hostname: config.apiAddr.host, port: config.apiAddr.port });
logger.info('Berry server listening', {
   apiAddr: `${config.apiAddr.host}:${config.apiAddr.port}`,
   environment: config.appEnv,
   // Named at boot so an operator can see which substrate this process would
   // run an agent's commands on, without reading the environment back.
   executionDriver: execution.name,
   // Named at boot because a server that admits runs but does not execute them
   // looks identical from outside until the first one sits queued forever.
   runDispatch: dispatcher ? `${config.agents!.concurrency} at a time` : 'off',
   // Named at boot so an operator can see whether a run can reach a
   // repository, without reading the environment back.
   integrations: connections
      ? config.integrations.github && config.integrations.publicUrl
         ? 'github'
         : 'no provider credentials'
      : 'no encryption key',
   mounts: registry.prefixes,
});

// Drain on SIGTERM before closing the pool, so a request in flight finishes
// rather than failing at the socket.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.once(signal, () => {
      logger.info('shutting down', { signal });
      server.close(() => {
         // The dispatcher first: it aborts what it is running, and a run left
         // mid-flight is reclaimed from its lease rather than recorded from a
         // process that is on its way out.
         void (dispatcher ? dispatcher.stop() : Promise.resolve())
            .then(() => closeDatabase(sql))
            .then(() => process.exit(0));
      });
   });
}

