-- Berry 060: people-valued custom properties, and free key/value metadata on
-- an issue for agents and integrations.

ALTER TABLE issue_property_definitions
    DROP CONSTRAINT IF EXISTS issue_property_definitions_kind_ck;
ALTER TABLE issue_property_definitions
    ADD CONSTRAINT issue_property_definitions_kind_ck
    CHECK (kind IN ('text', 'number', 'boolean', 'date', 'url', 'select', 'multi_select',
                    'person', 'multi_person'));

ALTER TABLE issue_property_definitions
    DROP CONSTRAINT IF EXISTS issue_property_definitions_config_shape_ck;
ALTER TABLE issue_property_definitions
    ADD CONSTRAINT issue_property_definitions_config_shape_ck
    CHECK (
        (
            kind IN ('text', 'number', 'boolean', 'date', 'url', 'person', 'multi_person')
            AND config = '{}'::jsonb
        )
        OR (
            kind IN ('select', 'multi_select')
            AND jsonb_typeof(config -> 'options') = 'array'
            AND jsonb_array_length(config -> 'options') BETWEEN 1 AND 100
        )
    );

ALTER TABLE issues ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issues
    ADD CONSTRAINT issues_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384);

-- The value trigger from 005 raises 'unknown property kind' for any kind it
-- does not list, so it must learn the two people kinds. Shape only here: that
-- the person is a member or agent of the workspace is checked in
-- work/properties.ts, where the error can name the field.
CREATE OR REPLACE FUNCTION berry_validate_property_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    property_kind text;
    property_config jsonb;
    property_archived_at timestamptz;
    scalar_value text;
BEGIN
    SELECT definition.kind, definition.config, definition.archived_at
      INTO property_kind, property_config, property_archived_at
      FROM issue_property_definitions AS definition
     WHERE definition.workspace_id = NEW.workspace_id
       AND definition.id = NEW.property_id;

    IF property_kind IS NULL OR property_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'property definition is unavailable'
            USING ERRCODE = '23503';
    END IF;

    scalar_value := NEW.value #>> '{}';
    CASE property_kind
        WHEN 'text' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 10000 THEN
                RAISE EXCEPTION 'invalid text property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'number' THEN
            IF jsonb_typeof(NEW.value) <> 'number' THEN
                RAISE EXCEPTION 'invalid number property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'boolean' THEN
            IF jsonb_typeof(NEW.value) <> 'boolean' THEN
                RAISE EXCEPTION 'invalid boolean property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'date' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR scalar_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
                RAISE EXCEPTION 'invalid date property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'url' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 2048
               OR scalar_value !~* '^https?://[^[:space:]]+$' THEN
                RAISE EXCEPTION 'invalid URL property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'select' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(property_config -> 'options') AS option
                    WHERE option ->> 'id' = scalar_value
               ) THEN
                RAISE EXCEPTION 'invalid select property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'multi_select' THEN
            IF jsonb_typeof(NEW.value) <> 'array'
               OR jsonb_array_length(NEW.value) > 50
               OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(NEW.value) AS selected
                    WHERE jsonb_typeof(selected) <> 'string'
                       OR NOT EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(property_config -> 'options') AS option
                            WHERE option ->> 'id' = selected #>> '{}'
                       )
               )
               OR (
                   SELECT count(*) <> count(DISTINCT selected #>> '{}')
                     FROM jsonb_array_elements(NEW.value) AS selected
               ) THEN
                RAISE EXCEPTION 'invalid multi-select property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'person' THEN
            IF jsonb_typeof(NEW.value) <> 'object'
               OR (NEW.value ->> 'type') NOT IN ('user', 'agent')
               OR (NEW.value ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION 'invalid person property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'multi_person' THEN
            IF jsonb_typeof(NEW.value) <> 'array'
               OR jsonb_array_length(NEW.value) > 50
               OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(NEW.value) AS person
                    WHERE jsonb_typeof(person) <> 'object'
                       OR (person ->> 'type') IS NULL
                       OR (person ->> 'type') NOT IN ('user', 'agent')
                       OR (person ->> 'id') IS NULL
                       OR (person ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               )
               OR (
                   SELECT count(*) <> count(DISTINCT (person ->> 'type') || ':' || lower(person ->> 'id'))
                     FROM jsonb_array_elements(NEW.value) AS person
               ) THEN
                RAISE EXCEPTION 'invalid multi-person property value' USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'unknown property kind' USING ERRCODE = '23514';
    END CASE;
    RETURN NEW;
END
$$;
