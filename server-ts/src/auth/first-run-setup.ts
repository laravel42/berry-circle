import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Sql } from '../db/pool.ts';

/**
 * How the first person ever to open a deployment creates the GitHub App.
 *
 * Sign-in runs on an App whose credentials live in this database, and the App is
 * created from the browser by a signed-in user. On a fresh deployment that is a
 * circle: there is no App to sign in with, so there is nobody who may create
 * one. This is the way out of it, and it is deliberately the narrowest one that
 * works — a token the server prints to its own log at boot, which stands in for
 * a session on the manifest route and on nothing else.
 *
 * It is open only while this deployment has no App *and* no user: the moment
 * either exists there is either nothing left to set up or somebody who can be
 * asked to do it, and the path closes for good. The token is also good once,
 * so a log someone later reads is not a way in. Restarting the server mints a
 * new one, which is what to do if the App creation is abandoned halfway.
 */

/**
 * The identity migration 009 inserts so automated runs have an actor. It is not
 * a login — no session is ever issued for it — so a deployment that has only
 * this row has nobody who could create the App.
 */
const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';

/** What "nobody has set this up yet" is read from. */
export interface FirstRunWorld {
   hasApp(): Promise<boolean>;
   hasUser(): Promise<boolean>;
}

/** The two questions, asked of the database. */
export function databaseWorld(sql: Sql): FirstRunWorld {
   return {
      async hasApp() {
         const [row] = await sql<Array<{ present: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM github_apps) AS present`;
         return row?.present === true;
      },
      async hasUser() {
         const [row] = await sql<Array<{ present: boolean }>>`
            SELECT EXISTS (
               SELECT 1 FROM users WHERE id <> ${SYSTEM_USER_ID}::uuid
            ) AS present`;
         return row?.present === true;
      },
   };
}

export interface FirstRunSetupOptions {
   world: FirstRunWorld;
   /** Overridden in tests; a fresh random token otherwise. */
   token?: string;
}

export class FirstRunSetup {
   readonly token: string;
   readonly #world: FirstRunWorld;
   #spent = false;

   constructor(options: FirstRunSetupOptions) {
      this.#world = options.world;
      this.token = options.token ?? randomBytes(32).toString('base64url');
   }

   /** Whether the setup path exists at all right now. */
   async available(): Promise<boolean> {
      if (this.#spent) return false;
      if (await this.#world.hasApp()) return false;
      return !(await this.#world.hasUser());
   }

   /**
    * Spends the token, or refuses.
    *
    * The comparison is constant-time and the token is only spent on a match, so
    * a wrong guess neither leaks how wrong it was nor costs the operator theirs.
    */
   async claim(presented: string | null | undefined): Promise<boolean> {
      if (!presented || !matches(this.token, presented)) return false;
      if (!(await this.available())) return false;
      this.#spent = true;
      return true;
   }
}

function matches(expected: string, presented: string): boolean {
   const a = Buffer.from(expected, 'utf8');
   const b = Buffer.from(presented, 'utf8');
   return a.length === b.length && timingSafeEqual(a, b);
}
