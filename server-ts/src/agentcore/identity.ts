import {
   BedrockAgentCoreClient,
   GetResourceOauth2TokenCommand,
   GetWorkloadAccessTokenCommand,
   type Oauth2FlowType,
} from '@aws-sdk/client-bedrock-agentcore';
import { SourceControlAuthenticationError } from './errors.ts';

/**
 * AgentCore Identity, holding the GitHub credential so Berry does not.
 *
 * This is what replaces Berry's OAuth exchange, its token refresh, its
 * encrypted `access_token_encrypted` column and its GitHub App private key.
 * AgentCore owns the credential lifecycle; Berry asks for a token when it
 * needs one and never stores the answer.
 *
 * Two tokens, one flow. A *workload* access token identifies Berry itself to
 * AgentCore; a *resource* token is the GitHub credential AgentCore returns in
 * exchange. Conflating them is the easy mistake: the first authorises the
 * second, and only the second reaches GitHub.
 *
 * Nothing here is cached to disk or written to a row. The whole point of the
 * migration is that the only copy of a GitHub credential lives with AWS.
 */

export interface AgentCoreIdentityOptions {
   region: string;
   /** The OAuth2 credential provider configured in AgentCore for GitHub. */
   providerName: string;
   /** Berry's workload identity name, as registered with AgentCore. */
   workloadName: string;
   scopes?: string[];
   /** `M2M` for one workspace credential; `USER_FEDERATION` for per-person. */
   flow?: Oauth2FlowType;
   client?: BedrockAgentCoreClient;
   clock?: () => number;
   /** How long before expiry a cached token is treated as spent. */
   marginMs?: number;
}

/** Default GitHub scopes: enough to read and write repository content and issues. */
const DEFAULT_SCOPES = ['repo'];
const DEFAULT_MARGIN_MS = 60_000;
/** Held only in memory, and only until it is nearly spent. */
const ASSUMED_TTL_MS = 30 * 60 * 1000;

export class AgentCoreIdentity {
   readonly #client: BedrockAgentCoreClient;
   readonly #providerName: string;
   readonly #workloadName: string;
   readonly #scopes: string[];
   readonly #flow: Oauth2FlowType;
   readonly #clock: () => number;
   readonly #marginMs: number;
   #cached: { token: string; expiresAt: number } | null = null;

   constructor(options: AgentCoreIdentityOptions) {
      this.#client = options.client ?? new BedrockAgentCoreClient({ region: options.region });
      this.#providerName = options.providerName;
      this.#workloadName = options.workloadName;
      this.#scopes = options.scopes ?? DEFAULT_SCOPES;
      this.#flow = options.flow ?? 'M2M';
      this.#clock = options.clock ?? Date.now;
      this.#marginMs = options.marginMs ?? DEFAULT_MARGIN_MS;
   }

   /**
    * A GitHub access token, for the one thing a gateway cannot do.
    *
    * Git is a wire protocol: `git clone` and `git push` talk to github.com and
    * no tool call can stand in for them. So the API moves to the gateway and
    * the transport keeps a credential — but it is AgentCore's credential now,
    * fetched per run and never stored.
    */
   async githubToken(): Promise<string> {
      const now = this.#clock();
      if (this.#cached && this.#cached.expiresAt - this.#marginMs > now) {
         return this.#cached.token;
      }

      const workload = await this.#workloadToken();
      const response = await this.#client
         .send(
            new GetResourceOauth2TokenCommand({
               workloadIdentityToken: workload,
               resourceCredentialProviderName: this.#providerName,
               scopes: this.#scopes,
               // Berry acts as itself, not on behalf of a signed-in person:
               // the same installation credential serves every run in a
               // workspace, which is what the GitHub App did before this.
               // `USER_FEDERATION` is the alternative, for a deployment that
               // wants each person's own GitHub identity.
               oauth2Flow: this.#flow,
            })
         )
         .catch((cause: unknown) => {
            throw new SourceControlAuthenticationError(
               `AgentCore Identity did not return a GitHub token: ${message(cause)}`,
               { cause }
            );
         });

      const token = response.accessToken;
      if (!token) {
         // An authorization URL instead of a token means somebody has to
         // consent in a browser. Saying so is more useful than a null.
         throw new SourceControlAuthenticationError(
            response.authorizationUrl
               ? 'GitHub is not authorised for this AgentCore identity yet; complete the consent flow'
               : 'AgentCore Identity returned no GitHub token'
         );
      }

      this.#cached = { token, expiresAt: now + ASSUMED_TTL_MS };
      return token;
   }

   /** The credential a run clones and pushes with. */
   async gitCredential(): Promise<{ username: string; password: string }> {
      // GitHub's convention when a token stands in for a user.
      return { username: 'x-access-token', password: await this.githubToken() };
   }

   /** Headers authorising a gateway call as Berry's workload. */
   async gatewayHeaders(): Promise<Record<string, string>> {
      return { authorization: `Bearer ${await this.#workloadToken()}` };
   }

   async #workloadToken(): Promise<string> {
      const response = await this.#client
         .send(new GetWorkloadAccessTokenCommand({ workloadName: this.#workloadName }))
         .catch((cause: unknown) => {
            throw new SourceControlAuthenticationError(
               `AgentCore Identity refused Berry's workload identity: ${message(cause)}`,
               { cause }
            );
         });
      const token = response.workloadAccessToken;
      if (!token) {
         throw new SourceControlAuthenticationError('AgentCore returned no workload access token');
      }
      return token;
   }
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}
