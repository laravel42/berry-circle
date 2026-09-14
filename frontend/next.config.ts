import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
/** pnpm workspace root — Turbopack must resolve `next` from here, not `frontend/`. */
const repoRoot = path.join(frontendDir, '..');

function berryApiOrigin(): string {
   const candidate = (process.env.BERRY_API_ORIGIN || 'http://127.0.0.1:4000').trim();

   let parsed: URL;
   try {
      parsed = new URL(candidate);
   } catch {
      throw new Error('BERRY_API_ORIGIN must be an absolute HTTP(S) URL');
   }

   if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('BERRY_API_ORIGIN must be an HTTP(S) URL without credentials');
   }
   if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('BERRY_API_ORIGIN must be an origin without a path, query, or fragment');
   }

   return parsed.origin;
}

const apiOrigin = berryApiOrigin();

const nextConfig: NextConfig = {
   distDir: process.env.NEXT_DIST_DIR ?? '.next',
   devIndicators: false,
   experimental: {
      turbo: {
         root: repoRoot,
      },
   },
   async rewrites() {
      return [
         {
            source: '/api/:path*',
            destination: `${apiOrigin}/api/:path*`,
         },
         {
            source: '/v1/:path*',
            destination: `${apiOrigin}/v1/:path*`,
         },
         {
            source: '/health',
            destination: `${apiOrigin}/health`,
         },
         {
            source: '/ready',
            destination: `${apiOrigin}/ready`,
         },
      ];
   },
};

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl(nextConfig);
