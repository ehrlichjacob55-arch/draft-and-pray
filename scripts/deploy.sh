#!/usr/bin/env bash
# Usage: scripts/deploy.sh <dev|prod> [--auto-approve]
# Build -> terraform apply -> sync web -> invalidate CloudFront (no migrations: schema lives in code).
set -euo pipefail

usage() {
  echo "Usage: $0 <dev|prod> [--auto-approve]" >&2
  exit 2
}

ENV="${1:-}"
[[ "$ENV" == "dev" || "$ENV" == "prod" ]] || usage
shift
AUTO_APPROVE=""
for arg in "$@"; do
  case "$arg" in
    --auto-approve) AUTO_APPROVE="-auto-approve" ;;
    *) usage ;;
  esac
done

for cmd in pnpm terraform aws; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TF_DIR="infra/terraform/envs/$ENV"

echo "==> Building"
pnpm install --frozen-lockfile
pnpm build

echo "==> Terraform ($ENV)"
terraform -chdir="$TF_DIR" init -backend-config=backend.hcl
# shellcheck disable=SC2086
terraform -chdir="$TF_DIR" apply $AUTO_APPROVE

BUCKET="$(terraform -chdir="$TF_DIR" output -raw web_bucket)"
DIST_ID="$(terraform -chdir="$TF_DIR" output -raw distribution_id)"

echo "==> Syncing web build to s3://$BUCKET"
aws s3 sync apps/web/dist "s3://$BUCKET" --delete --exclude config.json

echo "==> Invalidating CloudFront ($DIST_ID)"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo "==> Done: https://$(terraform -chdir="$TF_DIR" output -raw cloudfront_domain)"
