-- Clear agent model pairings that Bedrock cannot serve.
--
-- Migration 047 moved OpenRouter's `anthropic/*` names to their Bedrock
-- inference-profile ids and, by design, left every other pairing untouched
-- "for an operator to see rather than guessed at". Those survivors — the
-- `openrouter/*` models with no Bedrock equivalent (ling, gpt-5-nano, mimo,
-- qwen, solar, gemini) and a stray `openai/gpt-4o-mini` — have no 1:1 profile
-- to rewrite to: the models simply do not exist on Bedrock. Left as they are,
-- each reads as unavailable in the picker (the catalogue only serves
-- `provider = 'bedrock'`), so the agent's model cannot be reassigned and the
-- pairing cannot even be re-selected to itself.
--
-- The safe resolution is to clear the pairing rather than guess a substitute a
-- wrong model that runs is worse than a missing one. A null pairing is a state
-- the product already handles: the agent shows no model and the picker prompts
-- for a valid Bedrock one, exactly like a freshly created agent. Provider and
-- name are cleared together because the app reads them as a pair.
--
-- Scoped to non-Bedrock rows so the profiles 047 already produced are not
-- disturbed, and idempotent: a second apply matches nothing.
UPDATE agents
   SET model_provider = NULL,
       model_name = NULL,
       updated_at = now()
 WHERE model_provider IS NOT NULL
   AND model_provider <> 'bedrock';
