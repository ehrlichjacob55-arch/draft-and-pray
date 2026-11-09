#!/usr/bin/env bash
# One-time (idempotent) GitHub setup after `terraform apply` in infra/terraform/bootstrap.
# Creates the dev/test/prod GitHub Environments, their deployment policies, the prod reviewer,
# and the repo/environment variables used by .github/workflows/deploy.yml.
# See docs/design/09-aws-architecture.md section 8.
#
# Usage: scripts/setup-github.sh [--dry-run]
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-ehrlichjacob55-arch/draft-and-pray}"
OWNER="${REPO%%/*}"
DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "Usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP_DIR="$ROOT/infra/terraform/bootstrap"

run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# gh api with a JSON body on stdin (printed instead of sent in dry-run).
api_json() {
  local method="$1" path="$2" body="$3"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] gh api -X $method $path --input - <<< $body"
  else
    printf '%s' "$body" | gh api -X "$method" "$path" --input - >/dev/null
  fi
}

if [[ "$DRY_RUN" == 0 ]]; then
  for cmd in gh jq terraform; do
    command -v "$cmd" >/dev/null || {
      echo "$cmd is required" >&2
      exit 1
    }
  done
  gh auth status >/dev/null 2>&1 || {
    echo "gh is not authenticated; run 'gh auth login'" >&2
    exit 1
  }
elif ! command -v gh >/dev/null || ! gh auth status >/dev/null 2>&1; then
  echo "[dry-run] note: gh missing or not authenticated (required for a real run)" >&2
fi

# --- Bootstrap outputs -------------------------------------------------------
OUT=""
if command -v terraform >/dev/null; then
  OUT="$(terraform -chdir="$BOOTSTRAP_DIR" output -json 2>/dev/null || true)"
fi
jq_get() { printf '%s' "$OUT" | jq -r "$1 // empty" 2>/dev/null || true; }

if [[ -n "$OUT" && "$OUT" != "{}" ]]; then
  STATE_BUCKET="$(jq_get '.state_bucket.value')"
  AWS_REGION_VAL="$(jq_get '.region.value')"
  ROLE_DEV="$(jq_get '.deploy_role_arns.value.dev')"
  ROLE_TEST="$(jq_get '.deploy_role_arns.value.test')"
  ROLE_PROD="$(jq_get '.deploy_role_arns.value.prod')"
fi
if [[ -z "${STATE_BUCKET:-}" || -z "${AWS_REGION_VAL:-}" || -z "${ROLE_DEV:-}" || -z "${ROLE_TEST:-}" || -z "${ROLE_PROD:-}" ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] bootstrap outputs unavailable; using placeholders" >&2
    STATE_BUCKET="${STATE_BUCKET:-<state_bucket>}"
    AWS_REGION_VAL="${AWS_REGION_VAL:-<region>}"
    ROLE_DEV="${ROLE_DEV:-<dnp-github-deploy-dev role arn>}"
    ROLE_TEST="${ROLE_TEST:-<dnp-github-deploy-test role arn>}"
    ROLE_PROD="${ROLE_PROD:-<dnp-github-deploy-prod role arn>}"
  else
    echo "Could not read bootstrap outputs. Apply infra/terraform/bootstrap first." >&2
    exit 1
  fi
fi

# --- Owner id for the prod reviewer ------------------------------------------
if [[ "$DRY_RUN" == 1 ]]; then
  OWNER_ID="0"
  echo "[dry-run] prod reviewer id is a placeholder (0); real run uses gh api users/$OWNER" >&2
else
  OWNER_ID="$(gh api "users/$OWNER" --jq .id)"
fi

# --- Environments --------------------------------------------------------------
# dev: custom branch policy, main only. test/prod: tag policy v* only.
api_json PUT "repos/$REPO/environments/dev" \
  '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
api_json PUT "repos/$REPO/environments/test" \
  '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
api_json PUT "repos/$REPO/environments/prod" \
  "{\"prevent_self_review\":false,\"reviewers\":[{\"type\":\"User\",\"id\":${OWNER_ID}}],\"deployment_branch_policy\":{\"protected_branches\":false,\"custom_branch_policies\":true}}"

# Idempotently ensure exactly the wanted policy exists for an environment.
ensure_policy() {
  local env="$1" name="$2" type="$3"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] ensure $env deployment policy {name=$name,type=$type}; delete any others"
    return
  fi
  local existing found=0 id pname ptype
  existing="$(gh api "repos/$REPO/environments/$env/deployment-branch-policies" \
    --jq '.branch_policies[] | [.id, .name, (.type // "branch")] | @tsv')"
  while IFS=$'\t' read -r id pname ptype; do
    [[ -n "$id" ]] || continue
    if [[ "$pname" == "$name" && "$ptype" == "$type" ]]; then
      found=1
    else
      gh api -X DELETE "repos/$REPO/environments/$env/deployment-branch-policies/$id" >/dev/null
    fi
  done <<<"$existing"
  if [[ "$found" == 0 ]]; then
    api_json POST "repos/$REPO/environments/$env/deployment-branch-policies" \
      "{\"name\":\"$name\",\"type\":\"$type\"}"
  fi
}
ensure_policy dev main branch
ensure_policy test 'v*' tag
ensure_policy prod 'v*' tag

# --- Variables -----------------------------------------------------------------
run gh variable set AWS_REGION --repo "$REPO" --body "$AWS_REGION_VAL"
run gh variable set TF_STATE_BUCKET --repo "$REPO" --body "$STATE_BUCKET"
run gh variable set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env dev --body "$ROLE_DEV"
run gh variable set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env test --body "$ROLE_TEST"
run gh variable set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env prod --body "$ROLE_PROD"

echo "Done. Note: workflow_dispatch of a branch (e.g. main) against test/prod is blocked by the"
echo "tag-only policies by design; roll back by dispatching an older v* tag."
