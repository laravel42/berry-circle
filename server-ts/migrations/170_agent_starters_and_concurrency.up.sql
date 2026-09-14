-- Berry migration 170: two pieces of an agent's configuration that had nowhere
-- to live.
--
-- `conversation_starters` are the openers a new chat with this agent offers.
-- Berry already generates suggestions from a workspace's recent work, but an
-- agent's author knows what it is for better than a heuristic does, and a
-- starter they wrote is also documentation of what the agent expects to be
-- asked. Three at most, because an empty chat that offers more than three
-- openers reads as a menu rather than as an invitation.
--
-- `max_concurrency` is how many tasks the agent may run at once. It is stored
-- rather than assumed so a screen can show it and an owner can change it; the
-- dispatcher's own ceiling still applies on top of whatever is set here.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS conversation_starters text[] NOT NULL
    DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrency integer;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_conversation_starters_ck;
ALTER TABLE agents ADD CONSTRAINT agents_conversation_starters_ck CHECK (
    coalesce(array_length(conversation_starters, 1), 0) <= 3
) NOT VALID;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_max_concurrency_ck;
ALTER TABLE agents ADD CONSTRAINT agents_max_concurrency_ck CHECK (
    max_concurrency IS NULL OR (max_concurrency >= 1 AND max_concurrency <= 20)
) NOT VALID;

COMMENT ON COLUMN agents.conversation_starters IS
    'Up to three openers offered at the top of a new chat with this agent.';
COMMENT ON COLUMN agents.max_concurrency IS
    'How many tasks this agent may run at once; NULL leaves it to the dispatcher.';
