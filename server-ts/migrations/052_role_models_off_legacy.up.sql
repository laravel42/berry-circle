-- Move the planner roles off a model Bedrock no longer serves.
--
-- `model_role_agents` pins a model per role, and all four rows named
-- `us.anthropic.claude-sonnet-4-20250514-v1:0`. Invoked, that id now returns
-- ResourceNotFoundException: "This Model is marked by provider as Legacy and
-- you have not been actively using the model". So planning, repair, critique
-- and classification each failed at their first model call, whatever the
-- deployment's default model was set to — these rows outrank it by design.
--
-- Rewritten to Claude Haiku 4.5, which is verified invocable and calls tools.
-- It is also a third of Sonnet 4.5's price ($1/$5 per million against $3/$15),
-- and these four roles run on every plan, so they are the most repeated cost
-- in the product.
--
-- Narrow on purpose: only the exact legacy id is rewritten. A row an operator
-- pointed somewhere else is left alone and will fail loudly rather than be
-- silently repointed at a model nobody chose — the same rule migration 047
-- set, for the same reason. A wrong model that runs is worse than a missing
-- one that does not.
--
-- Idempotent: a second apply matches nothing.
UPDATE model_role_agents
   SET model_provider = 'bedrock',
       model_name = 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
       updated_at = now()
 WHERE model_name = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
