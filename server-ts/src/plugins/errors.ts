import type { z } from 'zod';

export interface PluginFieldError {
   path: string;
   message: string;
}

/** A package, config or secret the plugin does not allow. Mapped to 422. */
export class InvalidPluginInput extends Error {
   override readonly name = 'InvalidPluginInput';
   readonly fields: PluginFieldError[];
   constructor(fields: PluginFieldError[]) {
      super('invalid plugin input');
      this.fields = fields;
   }
}

/** The plugin's endpoint could not be reached safely. Mapped to 502. */
export class PluginUnreachable extends Error {
   override readonly name = 'PluginUnreachable';
}

/** The workspace already has a plugin with this key. Mapped to 409. */
export class PluginAlreadyInstalled extends Error {
   override readonly name = 'PluginAlreadyInstalled';
}

export function zodFields(error: z.ZodError): PluginFieldError[] {
   return error.issues.map((issue) => ({
      path: '/' + issue.path.map(String).join('/'),
      message: issue.message,
   }));
}
