-- Berry migration 018: issue identifiers are workspace-prefixed, not board-prefixed.
--
-- The public identifier is PREFIX-N. PREFIX is the first three ASCII
-- alphanumeric characters of the workspace name (already stored as
-- settings.issuePrefix, previously defaulted to the literal BERRY and unused
-- when formatting identifiers). N is the sequential issue number on the board.
-- Formatting lives in berry_issue_identifier so every read path stays in lockstep.

UPDATE workspaces
SET settings = jsonb_set(
    settings,
    '{issuePrefix}',
    to_jsonb(
        CASE
            WHEN length(derived.name_prefix) >= 2
                 AND substring(derived.name_prefix from 1 for 1) ~ '^[A-Z]$'
                THEN left(derived.name_prefix, 3)
            WHEN length(derived.slug_prefix) >= 2
                 AND substring(derived.slug_prefix from 1 for 1) ~ '^[A-Z]$'
                THEN left(derived.slug_prefix, 3)
            ELSE 'WS'
        END
    ),
    true
)
FROM (
    SELECT
        id,
        upper(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) AS name_prefix,
        upper(regexp_replace(slug, '[^A-Za-z0-9]', '', 'g')) AS slug_prefix
    FROM workspaces
) AS derived
WHERE workspaces.id = derived.id;

CREATE OR REPLACE FUNCTION berry_issue_identifier(
    p_workspace_id uuid,
    p_number integer
) RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT upper(coalesce(settings->>'issuePrefix', '')) || '-' || p_number::text
      FROM workspaces
     WHERE id = p_workspace_id
$$;
