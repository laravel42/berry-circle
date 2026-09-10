export interface SurfaceLaunch {
   token: string;
   expiresAt: string;
   apiUrl: string;
   workspaceId: string;
   installationId: string;
}

/**
 * Reads what Berry put in the iframe URL's fragment. Call it once on load and
 * then clear `location.hash`, so the token does not linger in history.
 */
export function readSurfaceLaunch(hash: string): SurfaceLaunch | null {
   const params = new URLSearchParams(hash.replace(/^#/, ''));
   const token = params.get('token') ?? '';
   if (!token.startsWith('berry_plg_')) return null;
   return {
      token,
      expiresAt: params.get('expiresAt') ?? '',
      apiUrl: params.get('apiUrl') ?? '',
      workspaceId: params.get('workspaceId') ?? '',
      installationId: params.get('installationId') ?? '',
   };
}
