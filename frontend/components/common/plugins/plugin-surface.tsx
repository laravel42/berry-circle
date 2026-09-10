'use client';

import { launchPluginSurface } from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * A plugin's page, in an iframe on the plugin's own origin.
 *
 * The launch URL carries a short-lived plugin token in its fragment, which the
 * plugin reads with the SDK's `readSurfaceLaunch`. The frame runs on another
 * origin, so `allow-same-origin` gives it its own origin's storage and never
 * Berry's. No referrer is sent, so the Berry URL does not leak to the plugin
 * host either.
 */
export default function PluginSurface() {
   const { pluginId, surface } = useParams<{ pluginId: string; surface: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [src, setSrc] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      launchPluginSurface(workspaceId, pluginId, surface)
         .then((launched) => {
            if (!cancelled) setSrc(launched.url);
         })
         .catch((cause: unknown) => {
            if (!cancelled)
               setError(cause instanceof Error ? cause.message : 'This page could not be opened.');
         });
      return () => {
         cancelled = true;
      };
   }, [workspaceId, pluginId, surface]);

   if (error) return <p className="p-6 text-muted-foreground">{error}</p>;
   if (!src) return <p className="p-6 text-muted-foreground">Opening…</p>;
   return (
      <iframe
         title="Plugin page"
         src={src}
         className="h-full w-full border-0"
         sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
         referrerPolicy="no-referrer"
      />
   );
}
