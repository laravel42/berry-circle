#!/usr/bin/env bash
#
# Enable Amazon Bedrock model access from the CLI.
#
# Bedrock will not let an account invoke a foundation model until an access
# agreement (the provider's EULA) has been accepted for it. The console has a
# "Model access" page for this; this script does the same over the CLI so the
# set of models Berry's agents can use is reproducible rather than clicked.
#
# For each requested model it runs the three-step flow AWS documents:
#   1. list-foundation-models            — confirm the model exists in-region
#   2. list-foundation-model-agreement-offers --model-id <id>   — get an offer token
#   3. create-foundation-model-agreement --model-id <id> --offer-token <token>
#
# Agreements are account-and-region scoped and can only be created in the
# standard regions us-east-1 / us-west-2, so the script defaults there and
# refuses others. A model already enabled is reported and skipped, so re-running
# is safe.
#
# Requires: awscli v2, and an identity with these actions (add to the Berry
# Bedrock policy, or use a broader admin identity to run this once):
#   bedrock:ListFoundationModels
#   bedrock:ListFoundationModelAgreementOffers
#   bedrock:CreateFoundationModelAgreement
#   bedrock:GetFoundationModelAvailability
#   aws-marketplace:Subscribe   (the agreement is a Marketplace subscription)
#
# Anthropic note: a first-time Anthropic customer must also submit the one-time
# use-case form (console Model access page, or the PutUseCaseForModelAccess
# API) before an agreement will let a model be invoked. This script surfaces
# that as a hint if an agreement is refused for that reason.
#
# Usage:
#   scripts/enable-bedrock-models.sh [--region us-east-1] [--dry-run] [PROVIDER ...]
#
# PROVIDER is a provider name as Bedrock reports it (anthropic, meta, mistral,
# amazon, cohere, ai21, deepseek, ...). With none given, the default set below
# is used. Examples:
#   scripts/enable-bedrock-models.sh                     # the default set
#   scripts/enable-bedrock-models.sh anthropic meta      # just these two
#   scripts/enable-bedrock-models.sh --dry-run           # show, change nothing
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=false
PROVIDERS=()

# The providers enabled when none are named. Text-generation families Berry's
# agents can actually run on; edit freely. Provider names are matched
# case-insensitively against what Bedrock reports (e.g. it lists OpenAI's
# models under the provider name "OpenAI").
DEFAULT_PROVIDERS=(anthropic openai meta mistral amazon)

# Only these regions host the agreement/EULA flow. Enabling here grants the
# account access; cross-region inference profiles then invoke from elsewhere.
ALLOWED_REGIONS=(us-east-1 us-west-2)

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) PROVIDERS+=("$1"); shift ;;
  esac
done

[[ ${#PROVIDERS[@]} -eq 0 ]] && PROVIDERS=("${DEFAULT_PROVIDERS[@]}")

command -v aws >/dev/null 2>&1 || die "the AWS CLI (aws) is not installed"

# Refuse a region the agreement flow does not serve, rather than fail per-model
# with a confusing error deep in the loop.
if [[ ! " ${ALLOWED_REGIONS[*]} " == *" ${REGION} "* ]]; then
  die "model agreements can only be created in: ${ALLOWED_REGIONS[*]} (got ${REGION})"
fi

# Fail early and clearly if the credentials are not usable, instead of letting
# every model report an opaque access error.
aws sts get-caller-identity >/dev/null 2>&1 \
  || die "AWS credentials are not usable (aws sts get-caller-identity failed). Check your profile/keys."

echo "Region: ${REGION}"
echo "Providers: ${PROVIDERS[*]}"
$DRY_RUN && echo "(dry run — no agreements will be created)"
echo

# The catalogue once, then filtered per provider. modelLifecycle ACTIVE only,
# so a deprecated model is not offered. jq is used when present for robustness;
# a --query fallback keeps the script working without it.
have_jq=false
command -v jq >/dev/null 2>&1 && have_jq=true

list_models_for_provider() {
  local provider="$1"
  # Match on the model-id prefix, which is always the lowercase provider key
  # (mistral., qwen., anthropic.), not on providerName. Bedrock's reported
  # provider name is free text with spaces ("Mistral AI", "Amazon"), so an
  # exact providerName compare drops whole families; the id prefix is stable.
  local prefix
  prefix="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')."
  if $have_jq; then
    aws bedrock list-foundation-models --region "$REGION" --output json 2>/dev/null \
      | jq -r --arg p "$prefix" '
          .modelSummaries[]
          | select(.modelId | ascii_downcase | startswith($p))
          | select((.modelLifecycle.status // "ACTIVE") == "ACTIVE")
          | select((.outputModalities // ["TEXT"]) | index("TEXT"))
          | .modelId'
  else
    # No jq: same id-prefix match via --query + grep, so both paths agree.
    aws bedrock list-foundation-models \
      --region "$REGION" \
      --query "modelSummaries[?modelLifecycle.status=='ACTIVE'].modelId" \
      --output text 2>/dev/null \
      | tr '\t' '\n' \
      | grep -i "^${prefix}" || true
  fi
}

# Whether an agreement is already in place for a model.
already_enabled() {
  local model_id="$1"
  local status
  status="$(aws bedrock get-foundation-model-availability \
    --region "$REGION" --model-id "$model_id" \
    --query 'agreementAvailability.status' --output text 2>/dev/null || echo '')"
  [[ "$status" == "AVAILABLE" ]]
}

enable_model() {
  local model_id="$1"

  if already_enabled "$model_id"; then
    note "already enabled: $model_id"
    return 0
  fi

  if $DRY_RUN; then
    note "would enable: $model_id"
    return 0
  fi

  # The offer token carries the EULA terms; it is required to accept.
  local offer
  offer="$(aws bedrock list-foundation-model-agreement-offers \
    --region "$REGION" --model-id "$model_id" \
    --query 'offers[0].offerToken' --output text 2>/dev/null || echo '')"

  if [[ -z "$offer" || "$offer" == "None" ]]; then
    note "no agreement offer for $model_id (region mismatch, or not offered here) — skipped"
    return 0
  fi

  if aws bedrock create-foundation-model-agreement \
      --region "$REGION" --model-id "$model_id" --offer-token "$offer" >/dev/null 2>&1; then
    note "enabled: $model_id"
  else
    # The most common cause for Anthropic is the missing first-time use-case
    # form, which the CLI cannot submit; point at it rather than swallow it.
    note "could NOT enable $model_id"
    if [[ "$model_id" == anthropic.* ]]; then
      note "  → Anthropic first-time access needs the use-case form: enable this"
      note "    model once in the Bedrock console (Model access), then re-run."
    fi
  fi
}

for provider in "${PROVIDERS[@]}"; do
  echo "Provider: ${provider}"
  # A `while read` loop rather than `mapfile`: mapfile is a bash 4+ builtin and
  # macOS still ships bash 3.2, so this keeps the script portable. The counter
  # stands in for "did the list have anything" without an array.
  found=0
  while IFS= read -r model_id; do
    [[ -z "$model_id" ]] && continue
    found=$((found + 1))
    enable_model "$model_id"
  done < <(list_models_for_provider "$provider")
  if [[ $found -eq 0 ]]; then
    note "no active text models found for '${provider}' in ${REGION}"
  fi
  echo
done

echo "Done. Verify in the picker, or with:"
echo "  aws bedrock list-foundation-models --region ${REGION} \\"
echo "    --query \"modelSummaries[].modelId\" --output text"
