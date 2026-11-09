# Draft & Pray infrastructure

Terraform for the AWS stack described in `docs/design/09-aws-architecture.md`.

```
bootstrap/      S3 state bucket (local state, run once per account)
modules/        data, auth, api, realtime, web, jobs, lambda_function (internal), app (composition)
envs/dev|prod   root modules; both call modules/app
```

## Prerequisites

- Terraform >= 1.10, AWS CLI v2, pnpm, Node 22
- AWS credentials for the target account (`aws sts get-caller-identity` should work)
- Lambda bundles built: `pnpm install && pnpm build` (produces `apps/api/dist/<handler>/index.mjs`).
  Terraform zips these at plan time, so build before `plan`/`apply`.

## 1. Bootstrap the state bucket (once per account)

```
cd infra/terraform/bootstrap
terraform init
terraform apply
```

Creates `dnp-tfstate-<account_id>` (versioned, SSE-S3, private, TLS-only). Its state stays local
(`terraform.tfstate`, gitignored); keep it or re-import the bucket if lost.

## 2. Initialise an environment

```
cd infra/terraform/envs/dev
cp backend.hcl.example backend.hcl        # set <account_id>
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl
```

## 3. Apply

Apply order is handled by the dependency graph; a single `terraform apply` creates everything.
Then deploy the app with `scripts/deploy.sh dev` (build, apply, S3 sync, CloudFront
invalidation). There are no migrations: the schema lives in code.

The app table `dnp-<env>-app` (DynamoDB, single-table, on-demand) is created by `modules/data`.
In prod it has point-in-time recovery and deletion protection enabled. Lambdas get item and
query permissions only on that table and its indexes (no Scan, no table admin).
Cost is effectively $0-1/month (docs/design/09 section 6).

## Operations

**Enable schedules** (disabled by default):

```
terraform apply -var ingest_enabled=true -var draft_backstop_enabled=true
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
