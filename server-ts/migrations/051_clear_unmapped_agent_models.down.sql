-- Irreversible by nature. The up migration cleared model pairings that named
-- models Bedrock cannot serve; the original `openrouter/*` and `openai/*`
-- values are not recoverable, and re-inventing them would restore exactly the
-- unavailable pairings the up migration removed. A rollback therefore leaves
-- the cleared agents as they are — model-less, awaiting a valid Bedrock pick —
-- which is a coherent state, not a broken one. This file exists to satisfy the
-- up/down pairing convention and to record that the data drop is deliberate.
SELECT 1;
