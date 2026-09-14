-- Model names, from OpenRouter's vocabulary to Bedrock's.
--
-- `anthropic/claude-sonnet-4` and `us.anthropic.claude-sonnet-4-20250514-v1:0`
-- name the same model on two hosts, and nothing derives one from the other:
-- Bedrock pins a version date and reaches Anthropic models through a
-- cross-region inference profile, which is the `us.` prefix. A row left as it
-- was would fail at the first call with a ValidationException that reads like
-- a typo.
--
-- Only the mappings Berry actually shipped are rewritten. A row naming
-- anything else is left alone and will fail loudly rather than be silently
-- pointed at a model nobody chose — a wrong model that works is worse than a
-- missing one that does not.
UPDATE agents
   SET model_provider = 'bedrock',
       model_name = CASE model_name
          WHEN 'anthropic/claude-sonnet-4'     THEN 'us.anthropic.claude-sonnet-4-20250514-v1:0'
          WHEN 'anthropic/claude-sonnet-4.5'   THEN 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
          WHEN 'anthropic/claude-opus-4'       THEN 'us.anthropic.claude-opus-4-20250514-v1:0'
          WHEN 'anthropic/claude-3.5-sonnet'   THEN 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'
          WHEN 'anthropic/claude-3.5-haiku'    THEN 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
          WHEN 'anthropic/claude-haiku-4.5'    THEN 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
          ELSE model_name
       END,
       updated_at = now()
 WHERE model_name IS NOT NULL
   AND model_name LIKE 'anthropic/%';

UPDATE model_role_agents
   SET model_provider = 'bedrock',
       model_name = CASE model_name
          WHEN 'anthropic/claude-sonnet-4'     THEN 'us.anthropic.claude-sonnet-4-20250514-v1:0'
          WHEN 'anthropic/claude-sonnet-4.5'   THEN 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
          WHEN 'anthropic/claude-opus-4'       THEN 'us.anthropic.claude-opus-4-20250514-v1:0'
          WHEN 'anthropic/claude-3.5-sonnet'   THEN 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'
          WHEN 'anthropic/claude-3.5-haiku'    THEN 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
          WHEN 'anthropic/claude-haiku-4.5'    THEN 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
          ELSE model_name
       END,
       updated_at = now()
 WHERE model_name IS NOT NULL
   AND model_name LIKE 'anthropic/%';

-- A model still carrying a provider slug after this is one nobody mapped. It
-- is left for an operator to see rather than guessed at.
COMMENT ON COLUMN agents.model_name IS
    'A Bedrock inference profile id, e.g. us.anthropic.claude-sonnet-4-20250514-v1:0.';
