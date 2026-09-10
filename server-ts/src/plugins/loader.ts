import { InvalidPluginInput, PluginUnreachable } from './errors.ts';
import { parsePackage, type PluginPackage } from './manifest.ts';
import type { PluginNetwork } from './net.ts';

export type PackageSource = { url: string } | { package: unknown };

export interface LoadedPackage {
   pkg: PluginPackage;
   source: 'url' | 'upload';
   sourceUrl: string | null;
}

/** Reads a package from where the admin pointed, and validates it. Writes nothing. */
export async function loadPackage(net: PluginNetwork, source: PackageSource): Promise<LoadedPackage> {
   if ('package' in source) {
      return { pkg: parsePackage(source.package), source: 'upload', sourceUrl: null };
   }
   const response = await net.request(source.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
   });
   if (response.status !== 200) {
      throw new PluginUnreachable(`plugin package answered ${response.status}`);
   }
   let json: unknown;
   try {
      json = JSON.parse(response.body);
   } catch {
      throw new InvalidPluginInput([{ path: '/url', message: 'The URL did not return a plugin package.' }]);
   }
   return { pkg: parsePackage(json), source: 'url', sourceUrl: source.url };
}
