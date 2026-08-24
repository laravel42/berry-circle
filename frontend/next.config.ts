import type { NextConfig } from 'next';

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
   async rewrites() {
      return [
         {
            source: '/api/:path*',
            destination: `${apiOrigin}/api/:path*`,
         },
         {
            source: '/health',
            destination: `${apiOrigin}/health`,
         },
         {
            source: '/ready',
            destination: `${apiOrigin}/ready`,
         },
         {
            source: '/uploads/:path*',
            destination: `${apiOrigin}/uploads/:path*`,
         },
      ];
   },
};

export default nextConfig;
