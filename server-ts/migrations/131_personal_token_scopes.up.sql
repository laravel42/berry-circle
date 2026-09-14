-- Scopes on personal access tokens for the public API.
-- NULL means every scope, so tokens issued before scopes existed keep working.
ALTER TABLE personal_api_tokens ADD COLUMN IF NOT EXISTS scopes text[];
COMMENT ON COLUMN personal_api_tokens.scopes IS
    'Public API scopes this token holds; NULL grants every scope (legacy tokens).';
