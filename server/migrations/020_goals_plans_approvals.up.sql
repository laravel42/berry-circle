-- Berry migration 020: goals, generated-plan IR on plans, generic approvals,
-- issue dependencies, automation issue origins.
--
-- A goal is the outcome a person asked for; issues are the finite work and
-- automations (021) the repeatable processes that serve it. The planner stores
-- its intermediate representation on the existing plans table so approval is
-- one transactional compile, and every "ask me first" moment becomes a row in
-- approvals so nothing can start on the strength of a forgotten check.

-- ------------------------------------------------------------------- goals
CREATE TABLE IF NOT EXISTS goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid,
    title text NOT NULL,
    description text,
    status text NOT NULL DEFAULT 'draft',
    source text NOT NULL DEFAULT 'manual',
    source_prompt text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    deleted_at timestamptz,
    CONSTRAINT goals_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT goals_project_fk FOREIGN KEY (workspace_id, project_id)
        REFERENCES projects(workspace_id, id) ON DELETE SET NULL,
    CONSTRAINT goals_title_length_ck CHECK (char_length(title) BETWEEN 1 AND 500),
    CONSTRAINT goals_description_length_ck CHECK (description IS NULL OR char_length(description) <= 20000),
    CONSTRAINT goals_source_prompt_length_ck CHECK (source_prompt IS NULL OR char_length(source_prompt) <= 20000),
    CONSTRAINT goals_status_ck CHECK (status IN ('draft','planned','active','blocked','completed','cancelled')),
    CONSTRAINT goals_source_ck CHECK (source IN ('manual','ai')),
    CONSTRAINT goals_completed_ck CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS goals_workspace_order_idx ON goals (workspace_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS goals_workspace_status_idx ON goals (workspace_id, status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS goals_project_idx ON goals (workspace_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
DROP TRIGGER IF EXISTS berry_goals_set_updated_at ON goals;
CREATE TRIGGER berry_goals_set_updated_at BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

-- Mirrors plan_issues / issue_project_links: an issue belongs to at most one goal.
CREATE TABLE IF NOT EXISTS goal_issues (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    goal_id uuid NOT NULL,
    linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT goal_issues_goal_fk FOREIGN KEY (workspace_id, goal_id)
        REFERENCES goals(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS goal_issues_goal_idx ON goal_issues (workspace_id, goal_id, issue_id);
DROP TRIGGER IF EXISTS berry_goal_issues_workspace ON goal_issues;
CREATE TRIGGER berry_goal_issues_workspace BEFORE INSERT OR UPDATE ON goal_issues
    FOR EACH ROW EXECUTE FUNCTION berry_validate_owned_issue_row();

-- ------------------------------------------------------------------- plans
-- plans (010) becomes the header for BOTH orchestrator briefs and AI plans.
-- AI plans are goal-scoped: project_id stays NULL (the project lives on
-- goals.project_id) so plans_one_open_per_project_key never collides with
-- orchestrator briefs and a project can be re-planned any number of times.
ALTER TABLE plans ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS goal_id uuid,
    ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES boards(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'orchestrator',
    ADD COLUMN IF NOT EXISTS source_prompt text,
    ADD COLUMN IF NOT EXISTS ir jsonb,
    ADD COLUMN IF NOT EXISTS ir_version text,
    ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS planner_version text,
    ADD COLUMN IF NOT EXISTS confidence numeric(4,3),
    ADD COLUMN IF NOT EXISTS generation_status text NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS generation_error text,
    ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS compile_status text NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS compile_error text,
    ADD COLUMN IF NOT EXISTS compiled_at timestamptz,
    ADD COLUMN IF NOT EXISTS conversation_id uuid,
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_goal_fk;
ALTER TABLE plans ADD CONSTRAINT plans_goal_fk FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals(workspace_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_source_ck;
ALTER TABLE plans ADD CONSTRAINT plans_source_ck CHECK (source IN ('orchestrator','ai','manual')) NOT VALID;
-- Keeps the two shapes disjoint: a brief always names a project, an AI or
-- manual plan always names a goal and never a project.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_scope_ck;
ALTER TABLE plans ADD CONSTRAINT plans_scope_ck CHECK (
    (source = 'orchestrator' AND project_id IS NOT NULL)
    OR (source <> 'orchestrator' AND goal_id IS NOT NULL AND project_id IS NULL)) NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_ir_ck;
ALTER TABLE plans ADD CONSTRAINT plans_ir_ck CHECK (ir IS NULL OR (jsonb_typeof(ir) = 'object' AND octet_length(ir::text) <= 524288)) NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_generation_status_ck;
ALTER TABLE plans ADD CONSTRAINT plans_generation_status_ck CHECK (generation_status IN ('idle','running','succeeded','failed')) NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_validation_status_ck;
ALTER TABLE plans ADD CONSTRAINT plans_validation_status_ck CHECK (validation_status IN ('unknown','valid','invalid','blocked')) NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_compile_status_ck;
ALTER TABLE plans ADD CONSTRAINT plans_compile_status_ck CHECK (compile_status IN ('not_started','running','succeeded','failed')) NOT VALID;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_confidence_ck;
ALTER TABLE plans ADD CONSTRAINT plans_confidence_ck CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_open_per_goal_key ON plans (workspace_id, goal_id)
    WHERE goal_id IS NOT NULL AND status IN ('draft','pending_approval');
CREATE INDEX IF NOT EXISTS plans_goal_idx ON plans (workspace_id, goal_id, created_at DESC) WHERE goal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    version integer NOT NULL,
    origin text NOT NULL,                       -- generated|repaired|critic_revised|patched|edited
    ir jsonb NOT NULL,
    ir_version text NOT NULL DEFAULT '1',
    validation jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {errors:[],warnings:[]}
    critic jsonb,                                -- {verdict, problems[]} when a critic ran on this version
    patch jsonb,                                 -- the PlanPatch that produced this version
    created_by_type text NOT NULL,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plan_versions_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT plan_versions_plan_fk FOREIGN KEY (workspace_id, plan_id) REFERENCES plans(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT plan_versions_plan_version_key UNIQUE (plan_id, version),
    CONSTRAINT plan_versions_origin_ck CHECK (origin IN ('generated','repaired','critic_revised','patched','edited')),
    CONSTRAINT plan_versions_ir_ck CHECK (jsonb_typeof(ir) = 'object' AND octet_length(ir::text) <= 524288),
    CONSTRAINT plan_versions_validation_ck CHECK (jsonb_typeof(validation) = 'object' AND octet_length(validation::text) <= 262144),
    CONSTRAINT plan_versions_critic_ck CHECK (critic IS NULL OR (jsonb_typeof(critic) = 'object' AND octet_length(critic::text) <= 131072)),
    CONSTRAINT plan_versions_patch_ck CHECK (patch IS NULL OR (jsonb_typeof(patch) = 'object' AND octet_length(patch::text) <= 131072)),
    CONSTRAINT plan_versions_actor_ck CHECK (created_by_type IN ('user','system'))
);

CREATE TABLE IF NOT EXISTS planner_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    sequence integer NOT NULL,
    stage text NOT NULL,
    role text,                                   -- planner|repair|critic|classifier
    prompt_version text,
    model_provider text,
    model_name text,
    input_tokens bigint, output_tokens bigint, cost_micros bigint, duration_ms bigint,
    outcome text NOT NULL,                       -- ok|invalid|error|timeout|skipped
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,   -- codes/counts/ids only; never prompts or reasoning
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT planner_events_plan_fk FOREIGN KEY (workspace_id, plan_id) REFERENCES plans(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT planner_events_plan_sequence_key UNIQUE (plan_id, sequence),
    CONSTRAINT planner_events_stage_ck CHECK (stage IN ('intent','context','generate','validate','repair','critic','patch','approve','compile','execute')),
    CONSTRAINT planner_events_role_ck CHECK (role IS NULL OR role IN ('planner','repair','critic','classifier')),
    CONSTRAINT planner_events_outcome_ck CHECK (outcome IN ('ok','invalid','error','timeout','skipped')),
    CONSTRAINT planner_events_detail_ck CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 131072)
);
CREATE INDEX IF NOT EXISTS planner_events_plan_order_idx ON planner_events (plan_id, sequence);

-- --------------------------------------------------------------- approvals
CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind text NOT NULL,
    risk text NOT NULL DEFAULT 'medium',
    title text NOT NULL,
    description text,
    goal_id uuid,
    plan_id uuid,
    issue_id uuid REFERENCES issues(id) ON DELETE CASCADE,
    automation_id uuid, automation_run_id uuid, automation_step_run_id uuid,  -- FKs added in 021
    audit_event_id uuid REFERENCES integration_audit_events(id) ON DELETE SET NULL,
    requested_from_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_from_role text,
    requested_by_type text NOT NULL DEFAULT 'system',
    requested_by uuid,
    status text NOT NULL DEFAULT 'pending',
    decision_note text,
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT approvals_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT approvals_goal_fk FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT approvals_plan_fk FOREIGN KEY (workspace_id, plan_id) REFERENCES plans(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT approvals_kind_ck CHECK (kind IN ('plan','issue_start','automation_activation','automation_step','integration_action')),
    CONSTRAINT approvals_risk_ck CHECK (risk IN ('low','medium','high')),
    CONSTRAINT approvals_status_ck CHECK (status IN ('pending','approved','rejected','expired')),
    CONSTRAINT approvals_title_length_ck CHECK (char_length(title) BETWEEN 1 AND 500),
    CONSTRAINT approvals_description_length_ck CHECK (description IS NULL OR char_length(description) <= 20000),
    CONSTRAINT approvals_approver_ck CHECK (requested_from_user_id IS NOT NULL OR requested_from_role IN ('owner','admin','member')),
    CONSTRAINT approvals_requested_by_ck CHECK (requested_by_type IN ('user','system','agent')),
    CONSTRAINT approvals_resolution_ck CHECK (
        (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)
        OR (status IN ('approved','rejected') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
        OR (status = 'expired' AND resolved_at IS NOT NULL AND resolved_by IS NULL)),
    CONSTRAINT approvals_expiry_ck CHECK (expires_at IS NULL OR expires_at > requested_at)
);
CREATE INDEX IF NOT EXISTS approvals_workspace_pending_idx ON approvals (workspace_id, requested_at DESC, id DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_workspace_order_idx ON approvals (workspace_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS approvals_recipient_idx ON approvals (requested_from_user_id, status, requested_at DESC) WHERE requested_from_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_issue_idx ON approvals (issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_goal_idx ON approvals (workspace_id, goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_expiry_idx ON approvals (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_plan_key ON approvals (plan_id) WHERE kind = 'plan' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_issue_start_key ON approvals (issue_id) WHERE kind = 'issue_start' AND status = 'pending';
DROP TRIGGER IF EXISTS berry_approvals_set_updated_at ON approvals;
CREATE TRIGGER berry_approvals_set_updated_at BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

-- Sibling of berry_block_unapproved_plan_dispatch (010): an issue whose latest
-- issue_start approval is not 'approved' cannot reach todo, so intake can never
-- dispatch it. Raises restrict_violation (23001) exactly like 010; the Go
-- classifiers map 23001 to ErrApprovalRequired (409 APPROVAL_REQUIRED).
CREATE OR REPLACE FUNCTION berry_block_unapproved_issue_start() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE gate_status text;
BEGIN
    IF NEW.status IS DISTINCT FROM 'todo' THEN
        RETURN NEW;
    END IF;
    SELECT approval.status INTO gate_status
      FROM approvals AS approval
     WHERE approval.issue_id = NEW.id AND approval.kind = 'issue_start'
     ORDER BY approval.requested_at DESC, approval.id DESC
     LIMIT 1;
    IF gate_status IS NOT NULL AND gate_status <> 'approved' THEN
        RAISE EXCEPTION 'issue % is waiting for approval (%) and cannot be queued for an agent', NEW.id, gate_status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS berry_issues_block_unapproved_start ON issues;
CREATE TRIGGER berry_issues_block_unapproved_start
    BEFORE INSERT OR UPDATE OF status ON issues
    FOR EACH ROW EXECUTE FUNCTION berry_block_unapproved_issue_start();

-- ------------------------------------------------------- issue dependencies
CREATE TABLE IF NOT EXISTS issue_dependencies (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,             -- dependent
    depends_on_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,  -- blocker
    kind text NOT NULL DEFAULT 'blocks',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, depends_on_issue_id),
    CONSTRAINT issue_dependencies_not_self_ck CHECK (issue_id <> depends_on_issue_id),
    CONSTRAINT issue_dependencies_kind_ck CHECK (kind IN ('blocks'))
);
CREATE INDEX IF NOT EXISTS issue_dependencies_blocker_idx ON issue_dependencies (workspace_id, depends_on_issue_id, issue_id);
-- Both ends must live in the supplied workspace (foreign_key_violation, like
-- berry_validate_owned_issue_row) and the edge must not close a cycle
-- (check_violation): a cycle would leave every issue in it blocked forever.
CREATE OR REPLACE FUNCTION berry_validate_issue_dependency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE dependent_ws uuid; blocker_ws uuid; has_cycle boolean;
BEGIN
    SELECT board.workspace_id INTO dependent_ws FROM issues JOIN boards AS board ON board.id = issues.board_id WHERE issues.id = NEW.issue_id;
    SELECT board.workspace_id INTO blocker_ws   FROM issues JOIN boards AS board ON board.id = issues.board_id WHERE issues.id = NEW.depends_on_issue_id;
    IF dependent_ws IS NULL OR blocker_ws IS NULL OR dependent_ws <> NEW.workspace_id OR blocker_ws <> NEW.workspace_id THEN
        RAISE EXCEPTION 'issue dependency crosses workspaces' USING ERRCODE = 'foreign_key_violation';
    END IF;
    WITH RECURSIVE reach(id) AS (
        SELECT depends_on_issue_id FROM issue_dependencies WHERE issue_id = NEW.depends_on_issue_id
        UNION
        SELECT d.depends_on_issue_id FROM issue_dependencies AS d JOIN reach AS r ON d.issue_id = r.id)
    SELECT EXISTS (SELECT 1 FROM reach WHERE id = NEW.issue_id) INTO has_cycle;
    IF has_cycle THEN
        RAISE EXCEPTION 'issue dependency cycle' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS berry_issue_dependencies_validate ON issue_dependencies;
CREATE TRIGGER berry_issue_dependencies_validate BEFORE INSERT OR UPDATE ON issue_dependencies
    FOR EACH ROW EXECUTE FUNCTION berry_validate_issue_dependency();

-- ------------------------------------------- automation issue origins
-- Junction (house style) instead of nullable FK columns on issues. FKs to the
-- automation tables are added in 021 once they exist.
CREATE TABLE IF NOT EXISTS automation_issue_origins (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    automation_id uuid NOT NULL,
    automation_run_id uuid NOT NULL,
    automation_step_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS berry_automation_issue_origins_workspace ON automation_issue_origins;
CREATE TRIGGER berry_automation_issue_origins_workspace BEFORE INSERT OR UPDATE ON automation_issue_origins
    FOR EACH ROW EXECUTE FUNCTION berry_validate_owned_issue_row();

-- Brief conversations may anchor to a goal as well as a plan.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS goal_id uuid;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_goal_fk;
ALTER TABLE conversations ADD CONSTRAINT conversations_goal_fk FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals(workspace_id, id) ON DELETE SET NULL NOT VALID;
