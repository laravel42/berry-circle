import type { MessageData } from '@strands-agents/sdk';
import type { TranscriptMessage } from '../../../runtime/envelope.ts';

/**
 * The transcript as Bedrock accepts it: alternating turns, user first, and
 * not ending on an unanswered user turn (the new prompt is the next one).
 */
export function toConversation(transcript: TranscriptMessage[]): MessageData[] {
   const merged: TranscriptMessage[] = [];
   for (const message of transcript) {
      if (message.text.trim() === '') continue;
      const last = merged.at(-1);
      if (last && last.role === message.role) last.text = `${last.text}\n\n${message.text}`;
      else merged.push({ ...message });
   }
   while (merged[0]?.role === 'assistant') merged.shift();
   if (merged.at(-1)?.role === 'user') merged.pop();
   return merged.map((message) => ({ role: message.role, content: [{ text: message.text }] }));
}
