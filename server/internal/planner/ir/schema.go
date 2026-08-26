package ir

// The JSON Schema documents below are the shapes handed to the model roles
// as text. Go decodes the replies strictly (Parse, ParseIntentReply,
// ParseCriticReply) and the checks in this package enforce the same rules,
// so the schema is guidance for the model and the decoder is the law.

// PlanSchemaJSON is BerryPlan v1 as a JSON Schema document.
const PlanSchemaJSON = `{
 "$schema": "http://json-schema.org/draft-07/schema#",
 "title": "BerryPlan v1",
 "type": "object", "additionalProperties": false,
 "required": ["$schema", "version", "goal", "assumptions", "requiredConnections", "issues", "workflows", "approvals", "dependencies", "confidence"],
 "properties": {
  "$schema": {"const": "berry-plan/1"},
  "version": {"const": "1"},
  "goal": {"type": "object", "additionalProperties": false, "required": ["tempId", "title"],
   "properties": {"tempId": {"type": "string", "pattern": "^g_[a-z0-9_]{1,40}$"}, "title": {"type": "string", "minLength": 1, "maxLength": 500},
    "description": {"type": "string", "maxLength": 20000}, "projectId": {"type": "string", "format": "uuid"}}},
  "assumptions": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["id", "description", "confidence", "userEditable"],
   "properties": {"id": {"type": "string", "pattern": "^a_[a-z0-9_]{1,40}$"}, "description": {"type": "string"},
    "confidence": {"enum": ["low", "medium", "high"]}, "userEditable": {"type": "boolean"}, "blocking": {"type": "boolean"}}}},
  "requiredConnections": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["provider", "purpose", "connected"],
   "properties": {"provider": {"type": "string", "pattern": "^[a-z][a-z0-9_]{1,63}$"}, "purpose": {"type": "string"}, "connected": {"type": "boolean"}}}},
  "issues": {"type": "array", "maxItems": 50, "items": {"type": "object", "additionalProperties": false, "required": ["tempId", "title", "type"],
   "properties": {"tempId": {"type": "string", "pattern": "^i_[a-z0-9_]{1,40}$"}, "title": {"type": "string", "minLength": 1, "maxLength": 500},
    "description": {"type": "string", "maxLength": 20000}, "type": {"const": "issue"}, "suggestedAgentId": {"type": "string", "format": "uuid"},
    "requiredCapabilities": {"type": "array", "items": {"type": "string", "pattern": "^[a-z0-9-]{1,50}$"}},
    "priority": {"enum": ["low", "medium", "high", "urgent"]}, "dependsOn": {"type": "array", "items": {"type": "string", "pattern": "^i_[a-z0-9_]{1,40}$"}},
    "requiresReview": {"type": "boolean"}, "requiresApproval": {"type": "boolean"},
    "expectedArtifacts": {"type": "array", "items": {"type": "string"}}, "estimate": {"type": "string"}}}},
  "workflows": {"type": "array", "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["tempId", "name", "trigger", "steps", "entry"],
   "properties": {"tempId": {"type": "string", "pattern": "^w_[a-z0-9_]{1,40}$"}, "name": {"type": "string", "minLength": 1, "maxLength": 200},
    "description": {"type": "string"}, "trigger": {"$ref": "#/$defs/Trigger"},
    "steps": {"type": "array", "minItems": 1, "maxItems": 40, "items": {"$ref": "#/$defs/Step"}},
    "entry": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/StepId"}}, "activateOnApprove": {"type": "boolean"}}}},
  "approvals": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["tempId", "title", "reason", "target", "approver"],
   "properties": {"tempId": {"type": "string", "pattern": "^p_[a-z0-9_]{1,40}$"}, "title": {"type": "string"}, "description": {"type": "string"},
    "reason": {"enum": ["policy", "user_requested", "planner"]},
    "target": {"type": "object", "additionalProperties": false, "required": ["kind", "tempId"],
     "properties": {"kind": {"enum": ["issue", "workflow", "step"]}, "tempId": {"type": "string"}, "stepId": {"$ref": "#/$defs/StepId"}}},
    "approver": {"$ref": "#/$defs/Approver"}, "timeout": {"$ref": "#/$defs/Duration"}}}},
  "dependencies": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["from", "to", "kind"],
   "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "kind": {"enum": ["blocks", "informs"]}}}},
  "confidence": {"type": "number", "minimum": 0, "maximum": 1}
 },
 "$defs": {
  "StepId": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"},
  "Duration": {"type": "string", "description": "ISO-8601 duration such as PT30M, PT4H, P7D or P2W"},
  "ValueReference": {"type": "object", "additionalProperties": false, "required": ["ref"],
   "properties": {"ref": {"type": "string", "pattern": "^(trigger|steps\\.[a-z][a-z0-9_]{0,63}\\.output|connections\\.[a-z0-9_]+|goal|item)(\\.[A-Za-z0-9_]+)*$"}}},
  "TemplateString": {"type": "string", "description": "Text with {{ ref-path }} placeholders using the ValueReference grammar"},
  "InputValue": {"anyOf": [{"$ref": "#/$defs/ValueReference"}, {"$ref": "#/$defs/TemplateString"}, {"type": ["number", "boolean", "null"]}]},
  "Operand": {"anyOf": [{"$ref": "#/$defs/ValueReference"}, {"type": ["string", "number", "boolean", "null"]}]},
  "ConditionExpression": {"type": "object", "additionalProperties": false, "required": ["op"],
   "properties": {"op": {"enum": ["equals", "not_equals", "greater_than", "less_than", "gte", "lte", "contains", "exists", "and", "or", "not"]},
    "left": {"$ref": "#/$defs/Operand"}, "right": {"$ref": "#/$defs/Operand"},
    "args": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"$ref": "#/$defs/ConditionExpression"}}},
   "description": "comparisons need left and right; exists needs a left reference; and/or take 1..10 args; not takes exactly 1"},
  "Approver": {"oneOf": [
   {"type": "object", "additionalProperties": false, "required": ["type", "userId"], "properties": {"type": {"const": "user"}, "userId": {"type": "string", "format": "uuid"}}},
   {"type": "object", "additionalProperties": false, "required": ["type", "role"], "properties": {"type": {"const": "role"}, "role": {"enum": ["owner", "admin", "member"]}}}]},
  "Trigger": {"type": "object", "additionalProperties": false, "required": ["id", "type"],
   "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"enum": ["integration", "schedule", "manual", "berry_event", "webhook"]},
    "provider": {"type": "string"}, "operation": {"type": "string"}, "event": {"type": "string"},
    "config": {"type": "object", "additionalProperties": false, "properties": {"cron": {"type": "string"}, "timezone": {"type": "string"}, "filter": {"$ref": "#/$defs/ConditionExpression"}}}},
   "description": "integration: provider+operation of a registered trigger tool; schedule: config.cron (5 fields) + config.timezone (IANA); berry_event: event from the published topics; manual; webhook"},
  "StepHeader": {"id": {"$ref": "#/$defs/StepId"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]}},
  "Step": {"oneOf": [
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "provider", "operation"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "action"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "provider": {"type": "string"}, "operation": {"type": "string"}, "input": {"type": "object", "additionalProperties": {"$ref": "#/$defs/InputValue"}}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "expression", "trueSteps"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "condition"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "expression": {"$ref": "#/$defs/ConditionExpression"}, "trueSteps": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "falseSteps": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "instruction"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "agent"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "agentId": {"type": "string", "format": "uuid"}, "requiredCapabilities": {"type": "array", "items": {"type": "string", "pattern": "^[a-z0-9-]{1,50}$"}},
     "instruction": {"$ref": "#/$defs/TemplateString"}, "input": {"type": "object", "additionalProperties": {"$ref": "#/$defs/InputValue"}},
     "outputSchema": {"type": "object"}, "issueMode": {"enum": ["inline", "issue"]}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "title"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "create_issue"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "title": {"$ref": "#/$defs/TemplateString"}, "description": {"$ref": "#/$defs/TemplateString"}, "assignAgentId": {"type": "string", "format": "uuid"},
     "priority": {"enum": ["none", "low", "medium", "high", "urgent"]}, "goalId": {"type": "string", "description": "a uuid or {{ goal.id }}"},
     "boardId": {"type": "string", "format": "uuid"}, "waitForCompletion": {"type": "boolean"}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "issue", "patch"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "update_issue"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "issue": {"$ref": "#/$defs/InputValue"}, "patch": {"type": "object", "additionalProperties": false,
      "properties": {"status": {"enum": ["backlog", "todo", "inProgress", "inReview", "done", "cancelled", "blocked"]}, "priority": {"enum": ["none", "low", "medium", "high", "urgent"]},
       "assignAgentId": {"type": "string", "format": "uuid"}, "title": {"$ref": "#/$defs/TemplateString"}, "description": {"$ref": "#/$defs/TemplateString"}}}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "title", "approver"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "approval"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "title": {"type": "string"}, "description": {"type": "string"}, "approver": {"$ref": "#/$defs/Approver"}, "timeout": {"$ref": "#/$defs/Duration"}}},
   {"type": "object", "additionalProperties": false, "required": ["id", "type", "mode"],
    "properties": {"id": {"$ref": "#/$defs/StepId"}, "type": {"const": "wait"}, "dependsOn": {"type": "array", "items": {"$ref": "#/$defs/StepId"}}, "onError": {"enum": ["fail", "skip"]},
     "mode": {"enum": ["duration", "until", "event"]}, "duration": {"$ref": "#/$defs/Duration"}, "until": {"$ref": "#/$defs/TemplateString"},
     "event": {"type": "object", "additionalProperties": false, "required": ["provider", "event"],
      "properties": {"provider": {"type": "string"}, "event": {"type": "string"}, "filter": {"$ref": "#/$defs/ConditionExpression"}}}}}
  ]}
 }
}`

// IntentSchemaJSON is IntentAnalysis as a JSON Schema document.
const IntentSchemaJSON = `{
 "title": "IntentAnalysis", "type": "object", "additionalProperties": false,
 "required": ["goal", "requirements", "ambiguities"],
 "properties": {
  "goal": {"type": "string", "minLength": 1, "maxLength": 500},
  "requirements": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "object", "additionalProperties": false,
   "required": ["id", "description", "nature", "entities", "explicitConstraints"],
   "properties": {"id": {"type": "string", "pattern": "^r[0-9]{1,3}$"}, "description": {"type": "string"},
    "nature": {"enum": ["finite_work", "event_driven", "scheduled", "approval", "unknown"]},
    "entities": {"type": "array", "items": {"type": "string"}}, "explicitConstraints": {"type": "array", "items": {"type": "string"}}}}},
  "ambiguities": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["id", "description", "blocking", "question"],
   "properties": {"id": {"type": "string", "pattern": "^q[0-9]{1,3}$"}, "description": {"type": "string"}, "blocking": {"type": "boolean"}, "question": {"type": "string"}}}},
  "language": {"type": "string"}
 }
}`

// CriticSchemaJSON is CriticVerdict as a JSON Schema document.
const CriticSchemaJSON = `{
 "title": "CriticVerdict", "type": "object", "additionalProperties": false,
 "required": ["verdict", "problems"],
 "properties": {
  "verdict": {"enum": ["accept", "revise"]},
  "problems": {"type": "array", "maxItems": 50, "items": {"type": "object", "additionalProperties": false,
   "required": ["code", "path", "message", "severity"],
   "properties": {"code": {"type": "string", "pattern": "^[A-Z_]{3,60}$"}, "path": {"type": "string", "description": "JSON pointer into the plan"},
    "message": {"type": "string"}, "severity": {"enum": ["error", "warning"]}}}}
 }
}`
