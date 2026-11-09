#!/usr/bin/env bash
# Usage: scripts/deploy.sh <dev|test|prod> [--auto-approve] [--skip-build]
# Build -> terraform apply -> sync web -> invalidate CloudFront (no migrations: schema lives in code).
# Used by humans and by .github/workflows/_deploy-env.yml (which passes --skip-build).
#
# backend.hcl: if infra/terraform/envs/<env>/backend.hcl is missing and TF_STATE_BUCKET and
# AWS_REGION are set, it is generated. Otherwise the file is required.
set -euo pipefail

usage() {
  echo "Usage: $0 <dev|test|prod> [--auto-approve] [--skip-build]" >&2
  exit 2
}

ENV="${1:-}"
case "$ENV" in
  dev | test | prod) ;;
  *) usage ;;
esac
shift
AUTO_APPROVE=""
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --auto-approve) AUTO_APPROVE="-auto-approve" ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) usage ;;
  esac
done

REQUIRED=(terraform aws)
[[ "$SKIP_BUILD" == 1 ]] || REQUIRED+=(pnpm)
for cmd in "${REQUIRED[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TF_DIR="infra/terraform/envs/$ENV"

if [[ "$SKIP_BUILD" == 1 ]]; then
  echo "==> Skipping build (using existing dist directories)"
  for d in apps/api/dist apps/web/dist; do
    [[ -d "$d" ]] || {
      echo "--skip-build given but $d is missing; build first or download the build artifact." >&2
      exit 1
    }
  done
else
  echo "==> Building"
  pnpm install --frozen-lockfile
  pnpm build
fi

BACKEND_HCL="$TF_DIR/backend.hcl"
if [[ ! -f "$BACKEND_HCL" ]]; then
  if [[ -n "${TF_STATE_BUCKET:-}" && -n "${AWS_REGION:-}" ]]; then
    echo "==> Generating $BACKEND_HCL"
    cat >"$BACKEND_HCL" <<HCL
bucket       = "${TF_STATE_BUCKET}"
key          = "draft-and-pray/${ENV}.tfstate"
region       = "${AWS_REGION}"
use_lockfile = true
encrypt      = true
HCL
  else
    echo "Missing $BACKEND_HCL. Copy backend.hcl.example, or set TF_STATE_BUCKET and AWS_REGION." >&2
    exit 1
  fi
fi

echo "==> Terraform ($ENV)"
terraform -chdir="$TF_DIR" init -input=false -backend-config=backend.hcl
# shellcheck disable=SC2086
terraform -chdir="$TF_DIR" apply -input=false $AUTO_APPROVE

BUCKET="$(terraform -chdir="$TF_DIR" output -raw web_bucket)"
DIST_ID="$(terraform -chdir="$TF_DIR" output -raw distribution_id)"
URL="https://$(terraform -chdir="$TF_DIR" output -raw cloudfront_domain)"

echo "==> Syncing web build to s3://$BUCKET"
aws s3 sync apps/web/dist "s3://$BUCKET" --delete --exclude config.json

echo "==> Invalidating CloudFront ($DIST_ID)"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
echo "==> Done: $URL"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Deployed \`$ENV\`"
    echo "- URL: $URL"
    echo "- Commit: \`$COMMIT\`"
  } >>"$GITHUB_STEP_SUMMARY"
fi
