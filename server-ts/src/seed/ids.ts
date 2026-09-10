/** Stable Berry development identifiers. Safe to reference in local docs and tests. */

export const UserID = '11111111-1111-4111-8111-111111111101';
export const WorkspaceID = '11111111-1111-4111-8111-111111111110';
export const BoardID = '11111111-1111-4111-8111-111111111120';
export const TextToSpeechAgentID = '11111111-1111-4111-8111-111111111131';
export const TextToVideoAgentID = '11111111-1111-4111-8111-111111111132';

export const UserEmail = 'prototype@berry.test';
export const UserName = 'Prototype User';
export const WorkspaceName = 'Berry';
export const WorkspaceSlug = 'berry';
export const BoardName = 'Platform';
export const BoardSlug = 'platform';

/**
 * The model a seeded agent runs on, chosen for cost per unit of useful work
 * rather than for either extreme.
 *
 * Claude Haiku 4.5 costs $1.00/$5.00 per million tokens against Sonnet 4.5's
 * $3.00/$15.00 — a third of the price — and still drives a tool-calling loop
 * reliably, which is the whole job here: a Berry run reads a repository, calls
 * `run_command`, writes files and pushes. Cheaper rows exist in the catalogue
 * (`nova-micro` at $0.035/$0.140, `llama3-2-1b`) and were rejected on purpose:
 * a model that loses the thread of a multi-step tool loop is not cheap, it
 * just fails for less per attempt, and a failed run costs a retry plus the
 * human who reads it. `claude-3-haiku` is cheaper again but predates this
 * class of agentic tool use.
 *
 * A Bedrock inference profile id, not an OpenRouter-style name. The `us.`
 * prefix is the cross-region profile and is what separates a call that works
 * from a ValidationException that reads like a typo — see migration 047.
 */
export const AgentModelProvider = 'bedrock';
export const AgentModelName = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
