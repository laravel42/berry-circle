import { createBerryAuth, type BerryAuth, type BerryAuthOptions } from './better-auth.ts';

/**
 * Sign-in, built when it is first needed rather than at boot.
 *
 * The GitHub App Berry signs people in with is created from the browser, which
 * means its credentials arrive *after* this process started. An instance built
 * once at boot would therefore be built without them, and the person who just
 * created the App would be told to restart the server before they could log
 * into it.
 *
 * So the credentials are resolved on use: the App in the database when there is
 * one, and `BERRY_AUTH_GITHUB_*` only as the fallback for a deployment that
 * still sets them. A cheap fingerprint — the App's client id and when its row
 * last changed — says whether the answer is the same one as last time, so there
 * is one instance per credential set rather than one per request, and a created,
 * changed or removed App is picked up on the next call.
 *
 * Nothing here logs a credential. The secret is opened only to hand to Better
 * Auth, and a failure to open it is reported as an error, never with its value.
 */

/** How the App's sign-in credentials are read, cheaply and then fully. */
export interface StoredGitHubCredentials {
   /**
    * A value that changes whenever the credentials do, and costs one small
    * query. Null when this deployment has no App.
    */
   fingerprint(): Promise<string | null>;
   /** The credentials themselves, opened. Null when there is no App. */
   credentials(): Promise<{ clientId: string; clientSecret: string } | null>;
}

export interface AuthProviderOptions extends Omit<BerryAuthOptions, 'github'> {
   /** `BERRY_AUTH_GITHUB_*`, used only when the database has no App. */
   fallback: { clientId: string; clientSecret: string } | null;
   /** The App's half of sign-in, when this deployment can hold an App. */
   stored: StoredGitHubCredentials | null;
   /** Overridden in tests; `createBerryAuth` otherwise. */
   create?: (options: BerryAuthOptions) => BerryAuth;
   /** Told when the stored credentials cannot be read. Never given a secret. */
   onError?: (error: unknown) => void;
}

/** The credential set an instance was built for, named so it can be compared. */
const NO_GITHUB = 'none';
const FROM_ENVIRONMENT = 'environment';

export class AuthProvider {
   readonly #options: AuthProviderOptions;
   readonly #create: (options: BerryAuthOptions) => BerryAuth;
   #current: { key: string; auth: BerryAuth } | null = null;
   /** The build in flight, so two requests arriving together share one. */
   #building: { key: string; auth: Promise<BerryAuth> } | null = null;

   constructor(options: AuthProviderOptions) {
      this.#options = options;
      this.#create = options.create ?? createBerryAuth;
   }

   /** The instance for the credentials in force now, building it if needed. */
   async instance(): Promise<BerryAuth> {
      const key = await this.#key();
      if (this.#current?.key === key) return this.#current.auth;
      if (this.#building?.key === key) return this.#building.auth;

      const building = this.#build(key);
      this.#building = { key, auth: building };
      try {
         const auth = await building;
         this.#current = { key, auth };
         return auth;
      } finally {
         if (this.#building?.key === key) this.#building = null;
      }
   }

   /**
    * Whether a person could sign in with GitHub *now*.
    *
    * Asked rather than answered from boot-time configuration, because the App
    * that makes it true may have been created a moment ago.
    */
   async githubSignIn(): Promise<boolean> {
      return (await this.#key()) !== NO_GITHUB;
   }

   /** Better Auth's own routes, for the mount that serves `/api/auth/*`. */
   async handler(request: Request): Promise<Response> {
      return (await this.instance()).handler(request);
   }

   /** The session behind a request's cookies, for the session service. */
   async getSession({ headers }: { headers: Headers }) {
      return (await this.instance()).api.getSession({ headers });
   }

   async #build(key: string): Promise<BerryAuth> {
      // Only Better Auth's own options: the fallback, the reader and the hooks
      // are this class's business and betterAuth() must not see them.
      const { fallback: _f, stored: _s, create: _c, onError: _e, ...base } = this.#options;
      return this.#create({ ...base, github: await this.#github(key) });
   }

   /** Which credential set is in force, without opening anything sealed. */
   async #key(): Promise<string> {
      const stored = await this.#fingerprint();
      if (stored !== null) return `app:${stored}`;
      return this.#options.fallback ? FROM_ENVIRONMENT : NO_GITHUB;
   }

   async #fingerprint(): Promise<string | null> {
      if (!this.#options.stored) return null;
      try {
         return await this.#options.stored.fingerprint();
      } catch (error) {
         this.#options.onError?.(error);
         return null;
      }
   }

   async #github(key: string): Promise<{ clientId: string; clientSecret: string } | null> {
      if (key === NO_GITHUB) return null;
      if (key === FROM_ENVIRONMENT) return this.#options.fallback;
      try {
         // The fingerprint said there is an App; if its secret cannot be opened
         // between then and here, the fallback is better than no sign-in at all.
         return (await this.#options.stored!.credentials()) ?? this.#options.fallback;
      } catch (error) {
         this.#options.onError?.(error);
         return this.#options.fallback;
      }
   }
}
