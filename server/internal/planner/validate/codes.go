package validate

// Codes the semantic rules emit. Structural and workflow codes come from
// ir.CheckStructure and automation.ValidateDefinition and are not repeated.
const (
	CodeAmbiguityBlocking = "AMBIGUITY_BLOCKING"

	CodeAgentUnknown               = "AGENT_UNKNOWN"
	CodeAgentCapabilityMissing     = "AGENT_CAPABILITY_MISSING"
	CodeAgentRepositoryAccess      = "AGENT_REPOSITORY_ACCESS"
	CodeAgentUnavailable           = "AGENT_UNAVAILABLE"
	CodeAgentHourlyCap             = "AGENT_HOURLY_CAP"
	CodeAgentStepShouldBeIssue     = "AGENT_STEP_SHOULD_BE_ISSUE"
	CodeAgentOrchestratorSuggested = "AGENT_ORCHESTRATOR_SUGGESTED"

	CodeDestructiveWithoutApproval = "DESTRUCTIVE_WITHOUT_APPROVAL"
	CodeCredentialLeak             = "CREDENTIAL_LEAK"
	CodeApprovalRemoved            = "APPROVAL_REMOVED"

	CodePlanForbidden         = "PLAN_FORBIDDEN"
	CodeNeedsAdminActivation  = "NEEDS_ADMIN_ACTIVATION"
	CodeScopeInvalid          = "SCOPE_INVALID"
	CodeApprovalApproverReqd  = "APPROVAL_APPROVER_REQUIRED"
	CodeIssueSimilarExists    = "ISSUE_SIMILAR_EXISTS"
	CodeWorkflowDuplicate     = "WORKFLOW_DUPLICATE"
	CodeWebhookProcessorExist = "WEBHOOK_PROCESSOR_EXISTS"
	CodeDeployAutomationExist = "DEPLOY_AUTOMATION_EXISTS"
)

// MinHourlyTokens is the hourly LLM token budget below which an agent is
// likely to trip its cap in the middle of an issue.
const MinHourlyTokens = 50_000

// SimilarityThreshold is the trigram similarity at which two issue titles
// are reported as the same issue.
const SimilarityThreshold = 0.8
