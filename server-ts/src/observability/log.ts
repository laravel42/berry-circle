/**
 * The JSON log line.
 *
 * One shape for every Berry process — the API, the migrator, the seeder — so a
 * single pipeline reads all of them and a field means the same thing wherever
 * it appears.
 */

export interface Logger {
   info(message: string, fields?: Record<string, unknown>): void;
   warn(message: string, fields?: Record<string, unknown>): void;
   error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(serviceName: string): Logger {
   const emit = (level: string, msg: string, fields: Record<string, unknown>): void => {
      console.log(
         JSON.stringify({
            time: new Date().toISOString(),
            level: level.toUpperCase(),
            msg,
            service: serviceName,
            ...fields,
         })
      );
   };
   return {
      info: (message, fields = {}) => emit('info', message, fields),
      warn: (message, fields = {}) => emit('warn', message, fields),
      error: (message, fields = {}) => emit('error', message, fields),
   };
}
