#!/usr/bin/env bash
# One-time (idempotent) GitHub setup after `terraform apply` in infra/terraform/bootstrap.
# Creates the dev/test/prod GitHub Environments, their deployment policies, the prod reviewer,
# the repo variables used by .github/workflows/deploy.yml, and (per environment) the deploy IAM
# user's access key, stored straight into the GitHub environment secrets AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY. See docs/design/09-aws-architecture.md section 8.
#
# Usage: scripts/setup-github.sh [--dry-run] [--rotate-keys]
#   --dry-run      print intended actions; change nothing
#   --rotate-keys  create a new key even if the environment already has AWS_ACCESS_KEY_ID,
#                  then delete the user's previous key(s). Rotate every 90 days.
#
# SECURITY: access keys live only in shell variables and pipes. Never enable `set -x`, never add
# an ERR/DEBUG trap, and never echo/print these variables or pass them via --body/argv.
set -euo pipefail
set +x

REPO="${GITHUB_REPOSITORY:-ehrlichjacob55-arch/draft-and-pray}"
OWNER="${REPO%%/*}"
DRY_RUN=0
ROTATE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rotate-keys) ROTATE=1 ;;
    *)
      echo "Usage: $0 [--dry-run] [--rotate-keys]" >&2
      exit 2
      ;;
  esac
done

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
  for cmd in gh jq terraform aws; do
    command -v "$cmd" >/dev/null || {
      echo "$cmd is required" >&2
      exit 1
    }
  done
  gh auth status >/dev/null 2>&1 || {
    echo "gh is not authenticated; run 'gh auth login'" >&2
    exit 1
  }
  # Respects AWS_PROFILE if set. Prints only the account id.
  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || {
    echo "aws CLI has no working credentials (check AWS_PROFILE / 'aws login'); needed to create access keys" >&2
    exit 1
  }
  echo "Using AWS account $AWS_ACCOUNT_ID${AWS_PROFILE:+ (profile $AWS_PROFILE)}"
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
  USER_DEV="$(jq_get '.deploy_user_names.value.dev')"
  USER_TEST="$(jq_get '.deploy_user_names.value.test')"
  USER_PROD="$(jq_get '.deploy_user_names.value.prod')"
fi
if [[ -z "${STATE_BUCKET:-}" || -z "${AWS_REGION_VAL:-}" || -z "${USER_DEV:-}" || -z "${USER_TEST:-}" || -z "${USER_PROD:-}" ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] bootstrap outputs unavailable; using placeholders" >&2
    STATE_BUCKET="${STATE_BUCKET:-<state_bucket>}"
    AWS_REGION_VAL="${AWS_REGION_VAL:-<region>}"
    USER_DEV="${USER_DEV:-<dnp-github-deploy-dev user>}"
    USER_TEST="${USER_TEST:-<dnp-github-deploy-test user>}"
    USER_PROD="${USER_PROD:-<dnp-github-deploy-prod user>}"
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

# --- Obsolete role-ARN environment variable --------------------------------------
# Delete it if present; a 404 (already gone) is fine.
for env in dev test prod; do
  run gh variable delete AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env "$env" 2>/dev/null || true
done

# --- Deploy IAM user access keys -> GitHub environment secrets --------------------
# Secret handling: the create-access-key JSON is held only in shell variables, handed to gh via
# stdin (printf | gh secret set), and unset right after. Nothing is echoed, logged or written.
setup_keys() {
  local env="$1" user="$2"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] $env: if both access key secrets exist and --rotate-keys not given, skip"
    echo "[dry-run] $env: aws iam list-access-keys --user-name $user (abort if it already has 2 keys)"
    echo "[dry-run] $env: aws iam create-access-key --user-name $user (output kept in a variable only)"
    echo "[dry-run] $env: gh secret set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY --env $env (via stdin)"
    if [[ "$ROTATE" == 1 ]]; then
      echo "[dry-run] $env: aws iam delete-access-key for the user's previous key(s) after both secrets are set"
    fi
    return 0
  fi

  # Skip only when BOTH secrets exist; a half-set pair (e.g. an earlier run failed mid-way) is redone.
  if [[ "$ROTATE" == 0 ]]; then
    local existing
    existing="$(gh secret list --env "$env" --repo "$REPO" --json name --jq '.[].name')"
    if grep -qx AWS_ACCESS_KEY_ID <<<"$existing" && grep -qx AWS_SECRET_ACCESS_KEY <<<"$existing"; then
      echo "$env: access key secrets already set; skipping key creation (use --rotate-keys to rotate)"
      return 0
    fi
  fi

  local old_keys count
  old_keys="$(aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
  count="$(printf '%s\n' "$old_keys" | wc -w | tr -d ' ')"
  if [[ "$count" -ge 2 ]]; then
    echo "$env: user $user already has 2 access keys (IAM maximum). Delete one in IAM, then re-run." >&2
    return 1
  fi

  local key_json key_id secret_key
  key_json="$(aws iam create-access-key --user-name "$user" --output json)"
  key_id="$(printf '%s' "$key_json" | jq -r '.AccessKey.AccessKeyId')"
  secret_key="$(printf '%s' "$key_json" | jq -r '.AccessKey.SecretAccessKey')"
  unset key_json

  if ! { printf '%s' "$key_id" | gh secret set AWS_ACCESS_KEY_ID --env "$env" --repo "$REPO" &&
    printf '%s' "$secret_key" | gh secret set AWS_SECRET_ACCESS_KEY --env "$env" --repo "$REPO"; }; then
    # Do not leave an orphaned key behind.
    aws iam delete-access-key --user-name "$user" --access-key-id "$key_id" >/dev/null || true
    unset secret_key key_id
    echo "$env: failed to store secrets in GitHub; the new access key was deleted. Aborting." >&2
    return 1
  fi
  unset secret_key

  local suffix="${key_id: -4}"
  unset key_id

  # Rotation: both secrets are stored, so retire the previous key(s).
  if [[ "$ROTATE" == 1 ]]; then
    local old
    for old in $old_keys; do
      aws iam delete-access-key --user-name "$user" --access-key-id "$old" >/dev/null
    done
  fi
  echo "$env: new key ...$suffix stored in GitHub secrets"
}

setup_keys dev "$USER_DEV"
setup_keys test "$USER_TEST"
setup_keys prod "$USER_PROD"

echo "Done. Note: workflow_dispatch of a branch (e.g. main) against test/prod is blocked by the"
echo "tag-only policies by design; roll back by dispatching an older v* tag."
