# Draft & Pray infrastructure

Terraform for the AWS stack described in `docs/design/09-aws-architecture.md`.

```
bootstrap/        S3 state bucket + 3 GitHub deploy IAM users (local state, run once per account)
modules/          data, auth, api, realtime, web, jobs, lambda_function (internal), app (composition)
envs/dev|test|prod  thin root modules over modules/app; each has a committed terraform.tfvars
```

| Env | Deployed by | Notes |
|---|---|---|
| dev | every push to `main` (after CI) | may break |
| test | pushing a tag `vX.Y.Z` | stable release candidate |
| prod | same tag, after approval in GitHub | `is_prod = true` (PITR, deletion protection) |

All three share one AWS account, isolated by `dnp-<env>-*` names and separate state keys
(`draft-and-pray/<env>.tfstate`). Full design: `docs/design/09-aws-architecture.md` section 8.

## Prerequisites

- Terraform >= 1.10, AWS CLI v2, pnpm, Node 22
- AWS credentials for the target account (`aws sts get-caller-identity` should work)
- Lambda bundles built: `pnpm install && pnpm build` (produces `apps/api/dist/<handler>/index.mjs`).
  Terraform zips these at plan time, so build before `plan`/`apply`.

## 1. Bootstrap (once per account, with admin credentials)

```
cd infra/terraform/bootstrap
terraform init
terraform apply
```

Creates the state bucket `dnp-tfstate-<account_id>` (versioned, SSE-S3, private, TLS-only) and
three IAM users `dnp-github-deploy-{dev,test,prod}` with `AdministratorAccess` for now (scope down
later). **No access keys are created here**: Terraform would store the secret in plaintext in
state. State stays local (`terraform.tfstate`, gitignored); keep it or re-import if lost.

**Why IAM users, not OIDC:** the AWS account belongs to an AWS Organization whose SCP denies
`iam:CreateOpenIDConnectProvider`, so GitHub OIDC roles are impossible. If the SCP is ever lifted,
OIDC is preferable (no stored secrets). See `docs/design/09-aws-architecture.md` section 8.

## 2. Configure GitHub (once, after bootstrap)

```
scripts/setup-github.sh --dry-run   # inspect the calls
scripts/setup-github.sh             # needs gh (repo admin), jq, terraform, aws (admin credentials)
```

Creates the `dev`, `test`, `prod` Environments (dev: branch `main` only; test/prod: tags `v*`
only; prod: required reviewer = repo owner, self-review allowed) and sets `AWS_REGION`,
`TF_STATE_BUCKET` (repo variables). For each environment it also creates an access key for the
matching deploy user and pipes it straight into the environment secrets `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` (never printed or written to disk). Re-running is safe: environments that
already have the secret are skipped.

### Key rotation and leaks

- Rotate every 90 days: `scripts/setup-github.sh --rotate-keys` creates a new key, updates the
  secrets, then deletes the old key. (IAM allows at most 2 keys per user.)
- If a key may have leaked: rotate immediately with `--rotate-keys`, or delete the key in the IAM
  console (Users -> `dnp-github-deploy-<env>` -> Security credentials) and then re-run the script
  to create a fresh one.

**Public repo note:** required reviewers on the free plan only work for public repos. If the repo
goes private, you need GitHub Pro/Team or the prod gate must change.

## 3. First deploys

- Merge/push to `main` -> `deploy.yml` runs CI, builds once, deploys **dev**.
- Release: `git tag v0.1.0 && git push origin v0.1.0` -> CI, build, deploy **test**, then **prod**
  waits for approval. Approve in the Actions run ("Review deployments"); the same build artifact
  that went to test is deployed to prod.
- **Rollback / redeploy:** the source is the ref you start the run from, because environment
  policies are checked against it. In the GitHub UI: Actions -> Deploy -> Run workflow -> Use
  workflow from: `<older tag>` (e.g. `v0.0.9`) -> environment: `prod`. CLI:
  `gh workflow run deploy.yml --ref v0.0.9 -f environment=prod`. Prod still needs approval.
  Dev takes `main`; test/prod accept only `v*` tags (a branch such as `main` is rejected, by
  design). CI is skipped on dispatch runs since the tag was already released.
- One deploy per environment runs at a time (`concurrency: deploy-<env>`).

## Local / manual deploys

For a human with credentials, in `envs/<env>`:

```
cd infra/terraform/envs/dev
cp backend.hcl.example backend.hcl        # set <account_id>; gitignored
cd ../../../..
scripts/deploy.sh dev                     # build, apply, S3 sync, CloudFront invalidation
scripts/deploy.sh test --auto-approve --skip-build   # reuse existing apps/*/dist
```

`deploy.sh` generates `backend.hcl` itself if `TF_STATE_BUCKET` and `AWS_REGION` are set (what CI
does). Non-secret inputs live in the committed `envs/<env>/terraform.tfvars` (auto-loaded);
secrets (stats API key) stay in SSM.

## Apply details

Apply order is handled by the dependency graph; a single `terraform apply` creates everything.
There are no migrations: the schema lives in code.

The app table `dnp-<env>-app` (DynamoDB, single-table, on-demand) is created by `modules/data`.
In prod it has point-in-time recovery and deletion protection enabled. Lambdas get item and
query permissions only on that table and its indexes (no Scan, no table admin).
Cost is effectively $0-1/month (docs/design/09 section 6).

## Operations

**Enable schedules** (disabled by default):

```
# edit ingest_enabled / draft_backstop_enabled in envs/<env>/terraform.tfvars (committed), then deploy
# or ad hoc: terraform apply -var ingest_enabled=true -var draft_backstop_enabled=true
```

**Set the stats API key** (Terraform creates a placeholder and ignores later value changes):

```
aws ssm put-parameter --name /dnp/dev/stats-api-key --type SecureString --overwrite --value '<key>'
```

**Invite users**: the pool is admin-create-only. Create users in the Cognito console or with
`aws cognito-idp admin-create-user --user-pool-id <id> --username a@b.com --user-attributes Name=email,Value=a@b.com Name=email_verified,Value=true`.

## First-apply caveats (09 section 7)

- **Cognito email OTP and SES**: the default Cognito sender may not be accepted for OTP mail. If
  sign-in emails do not arrive, verify an SES identity and set `ses_identity_arn` / `ses_from_email`.
  (Sandbox SES only sends to verified addresses.)
- `lambda_dist_dir` defaults to `apps/api/dist`; `terraform validate` works without it, but
  `plan` fails if a handler directory is missing.
- WebSocket API access logging is not configured (it requires an account-level API Gateway
  CloudWatch role); add it if needed.
