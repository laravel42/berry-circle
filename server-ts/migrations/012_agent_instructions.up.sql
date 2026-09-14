-- Berry migration 012: authored agent instructions.
--
-- The instructions are the system prompt applied to every task an agent runs.
-- The runtime owns execution, and its PATCH /api/agents/{id} accepts
-- `system_prompt`, so upstream remains authoritative for what the agent
-- actually runs with.
--
-- Berry stores a copy anyway, for two reasons: the upstream agent summary and
-- detail responses do not return the system prompt, so without a local copy the
-- editor would open empty and a save would silently discard whatever was there;
-- and the authored text is product content a workspace should keep even if the
-- runtime agent is later removed and recreated.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS instructions text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agents'::regclass
          AND conname = 'agents_instructions_length_ck'
    ) THEN
        -- Bounded well below the manifest limit: this is a prompt, and an
        -- unbounded text column reachable from an API is a denial-of-service
        -- surface as much as a correctness one.
        ALTER TABLE agents ADD CONSTRAINT agents_instructions_length_ck
            CHECK (instructions IS NULL OR char_length(instructions) <= 20000);
    END IF;
END
$$;

-- Records when Berry last pushed instructions upstream, so a local edit that
-- never reached the runtime is distinguishable from one that did.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instructions_synced_at timestamptz;
