-- Puts the legacy pin back, for a deployment that needs to reproduce the old
-- behaviour. Note that the model it restores is refused by Bedrock as Legacy,
-- so rolling this back restores a broken planner deliberately.
UPDATE model_role_agents
   SET model_name = 'us.anthropic.claude-sonnet-4-20250514-v1:0',
       updated_at = now()
 WHERE model_name = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
