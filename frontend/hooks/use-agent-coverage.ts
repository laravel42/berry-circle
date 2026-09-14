'use client';

import { getAgentCoverage, type AgentCoverage } from '@/lib/runtimes';
import { useEffect, useState } from 'react';

/**
 * Which agents have somewhere to run.
 *
 * An agent with no runtime of its own still runs on the workspace default, so
 * a screen asking "can this agent work?" has to read the coverage rather than
 * the agent's own binding, which is null for every agent that never chose one.
 *
 * Null while it loads. `agentHasRuntime` reads null as yes, so nothing is
 * refused on a guess. The request is shared across the components that ask for
 * it, and a failure clears the share so the next mount tries again.
 */
let inFlight: Promise<AgentCoverage> | null = null;

export function useAgentCoverage(): AgentCoverage | null {
   const [coverage, setCoverage] = useState<AgentCoverage | null>(null);

   useEffect(() => {
      let alive = true;
      inFlight ??= getAgentCoverage();
      void inFlight.then(
         (value) => {
            if (alive) setCoverage(value);
         },
         () => {
            inFlight = null;
         }
      );
      return () => {
         alive = false;
      };
   }, []);

   return coverage;
}
