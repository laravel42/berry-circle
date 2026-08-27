import type { Sql } from '../db/pool.ts';
import type { Dispatch } from '../runs/ledger.ts';
import { truncateUtf8 } from '../runs/result-comment.ts';

/**
 * The message a run sends its agent, ported from
 * server/internal/service/runadmission/service.go's buildMessage.
 *
 * The task text is carried over unchanged. The contracts at the end are not:
 * they exist because the runtime gave the agent no way to discover how its
 * work is collected, and under ADK the answer is different. OpenFang agents
 * wrote into an `output/` directory that Berry swept after the run; an ADK
 * agent calls `write_file`, and telling it about a directory that does not
 * exist would produce nothing at all.
 */

const MAX_PROMPT_BYTES = 64 * 1024;

export interface PromptContext extends Dispatch {
   /** Why a peer reviewer last sent this task back, when one did. */
   reviewFeedback?: string;
}

export function buildMessage(dispatch: PromptContext): string {
   let message = `Berry issue ${dispatch.issueIdentifier}\n\nTitle: ${dispatch.issueTitle}`;

   if (dispatch.issueDescription) {
      message += `\n\nDescription:\n${dispatch.issueDescription}`;
   }
   if (dispatch.instructions) {
      message += `\n\nRun instructions:\n${dispatch.instructions}`;
   }
   if (dispatch.reviewFeedback) {
      message +=
         '\n\nThis task was already worked once and sent back\n' +
         'A reviewing agent read the result and declined to approve it:\n\n' +
         dispatch.reviewFeedback +
         '\n\nAddress that specifically. Anything the review says is missing is the ' +
         'first thing to produce, and anything it says is wrong is not worth ' +
         'repeating. Files an earlier attempt saved are still there — call ' +
         'list_files to see them, and replace what needs replacing rather than ' +
         'starting from nothing.\n';
   }
   if (dispatch.repository) {
      message += `\n\nRepository: ${dispatch.repository}`;
   }

   // The contracts go last so the agent reads them with the task fresh, but
   // the cap cuts from the tail, so a long description would silently drop
   // them first. They get their room reserved; the description gives way.
   const contracts = reportingContract() + (dispatch.repository ? deliveryContract() : '');
   return truncateUtf8(message, MAX_PROMPT_BYTES - Buffer.byteLength(contracts, 'utf8')) + contracts;
}

/**
 * What becomes of the agent's last message.
 *
 * In the prompt because the agent cannot see it otherwise: to the model, a
 * turn ending with "I'll research this" is a plan it is about to carry out,
 * but Berry records the final message as the run's result and posts it on the
 * task. A promise in that position is an empty report, and the real findings
 * end up only where nobody looks.
 */
function reportingContract(): string {
   return (
      '\n\nReporting your result\n' +
      'Your final message is recorded as the result of this run and posted on ' +
      'the issue as your comment. End with a complete, self-contained answer: ' +
      'what you found, what you did, and anything the reader needs to know. Do ' +
      'not end on a plan or a promise to do work, and do not rely on anything ' +
      'you said earlier being read. The final message is the report; do not ' +
      'point the reader to a file for it.\n' +
      'Files you produce beyond it (data, generated documents, code) are saved ' +
      'with write_file, at the path they should have — write_file with path ' +
      'src/password/generator.ts stores it there, subdirectories and all. ' +
      'Describing a file is not writing one: a result that exists only in your ' +
      'reply has produced nothing to collect.\n' +
      'Work saved on this task by other agents is readable: list_files shows ' +
      'what is there and read_file opens it. Read before rewriting — a file ' +
      'another agent wrote is theirs to build on, not to guess at.\n'
   );
}

/**
 * How code is handed back.
 *
 * Spelled out because nothing in the runtime reveals it: there is no git, no
 * credential and no network path to the repository, so an agent left to work
 * it out describes the change it would make instead of writing it.
 */
function deliveryContract(): string {
   return (
      '\n\nDelivering your work\n' +
      'Save every file you want committed with write_file, at the path it ' +
      'should have in the repository: a change to src/api/handler.go is saved ' +
      'as src/api/handler.go. Those paths are the paths that are committed.\n' +
      "Save each file's complete new contents. Berry commits the file as you " +
      'wrote it rather than applying a patch, so a partial file replaces the ' +
      'whole one and deletes everything you left out.\n'
   );
}

/**
 * Why a peer reviewer last sent this task back.
 *
 * Empty when it was never rejected, which is the common case — an absent
 * rejection is not an error and must not stop a run.
 */
export async function lastRejection(sql: Sql, issueId: string): Promise<string> {
   const [row] = await sql`
      SELECT reason FROM issue_auto_reviews
       WHERE issue_id = ${issueId} AND approved = false
       ORDER BY decided_at DESC NULLS LAST
       LIMIT 1`;
   return (row?.reason as string | null) ?? '';
}
