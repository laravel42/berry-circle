/**
 * The run's answer and the text that reaches its ledger, apart from the loop
 * that produces them: both are Berry's own rules about what a run reports,
 * and they are tested without a model.
 */

export const MAX_SUMMARY_BYTES = 5_000;

/**
 * Separates an answer from a remark.
 *
 * A report is hundreds of bytes at the least; a sign-off ("I'll write that to
 * a file") is not. Recording the closing line as the result lost the answer it
 * followed, often enough that the distinction is worth this constant.
 */
export const SUBSTANTIVE_RESULT_BYTES = 400;


/**
 * The agent's final message, tracked across turns.
 *
 * Each turn's text is kept apart because the final message is what the agent
 * reports with: earlier turns ("I'll look into this") are progress. A turn
 * that says nothing, such as a bare tool call, leaves the result as it was.
 *
 * Ported from runadmission's resultText, including the distinction between the
 * last turn that said anything and the last that said enough to be a report.
 */
export class ResultText {
   private turn = '';
   private last = '';
   private substantive = '';
   private lastCut = false;
   private subCut = false;

   append(value: string): void {
      this.turn += value;
   }

   endTurn(): void {
      const text = this.turn.trim();
      if (text !== '') {
         const cut = Buffer.byteLength(text, 'utf8') > MAX_SUMMARY_BYTES;
         this.last = text;
         this.lastCut = cut;
         if (Buffer.byteLength(text, 'utf8') >= SUBSTANTIVE_RESULT_BYTES) {
            this.substantive = text;
            this.subCut = cut;
         }
      }
      this.turn = '';
   }

   /**
    * What the run reports.
    *
    * A substantive turn wins over a later thin one: an agent that finishes with
    * "Done." after a long explanation should report the explanation.
    */
   final(): [string, boolean] {
      if (this.substantive !== '') return [this.substantive, this.subCut];
      return [this.last, this.lastCut];
   }
}
