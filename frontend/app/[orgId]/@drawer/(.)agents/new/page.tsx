'use client';

import { useEffect } from 'react';

/**
 * `/agents/new` is not an agent, and must not open the agent drawer.
 *
 * It is a sibling of `/agents/[agentId]`, which the drawer slot intercepts, so
 * `[agentId]` matched the literal "new" on every client-side navigation: the
 * New agent link and the Duplicate action both opened a drawer reading "This
 * agent does not exist" over the list, and asked the server for
 * `/api/v1/agents/new` twice. A static segment beats a dynamic one, so this
 * file takes the match away from it.
 *
 * Claiming the match is only half of it. An intercepted navigation leaves the
 * children slot on the route it was already showing, so the create page would
 * never render and the list would sit there under a changed URL. Reloading at
 * the new address replays it as a real navigation, which nothing intercepts.
 */
export default function AgentCreateIsNotADrawer() {
   useEffect(() => {
      window.location.replace(window.location.href);
   }, []);
   return null;
}
