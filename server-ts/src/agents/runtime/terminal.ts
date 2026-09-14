/** The run already reached a terminal status; nothing more may be appended. */
export class RunTerminal extends Error {
   constructor() {
      super('run is terminal');
      this.name = 'RunTerminal';
   }
}
