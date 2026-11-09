# Draft & Pray

Web app for a 9-team NFL playoff fantasy league: live snake draft, then automatic cumulative scoring through the Super Bowl.

## Design docs — read before changing behavior

`docs/design/` is the spec. Start with `README.md`, then the doc for the area you're touching:

- 01 requirements · 02 domain model (entities + invariants I-1…I-7; storage in 10) · 03 draft · 04 scoring · 06 UI · 07 plan (task list in §4) · 08 open questions
- **09 AWS architecture is the binding infra/build contract.** It supersedes the Vercel/Supabase parts of 05.
- **10 DynamoDB data model is the binding storage contract**: keys, access patterns, and the transactions that enforce the invariants.

If code and docs disagree, flag it rather than silently picking one.

## Stack

pnpm monorepo, TypeScript everywhere, Node 22 on Lambda.

- `apps/web`: React + Vite + Tailwind v4 SPA (S3 + CloudFront); reads `/config.json` at runtime
- `apps/api`: Hono HTTP app + Lambda handlers (`src/handlers/*`), bundled by `scripts/build.mjs` to `dist/<handler>/index.mjs`
- `packages/domain`: pure rules (snake order, slot eligibility, scoring engine). No I/O; heavily unit-tested
- `packages/db`: DynamoDB single-table: table definition, key builders (`keys.ts`), zod item schemas, repositories. DynamoDB Local (Java) for dev and tests
- `infra/terraform`: AWS (DynamoDB, Cognito, API Gateway HTTP + WebSocket, Lambda, EventBridge Scheduler, CloudFront)

## Commands

```bash
pnpm install
pnpm ddb:local           # DynamoDB Local on :8000 (needs Java; run first)
pnpm dev                 # api on :3001 + web on :5173
pnpm lint && pnpm typecheck && pnpm test && pnpm build
terraform -chdir=infra/terraform/envs/dev validate
scripts/deploy.sh dev    # requires AWS credentials + backend.hcl
```

## Environments & releases (09 §8)

- **dev**: auto-deploys on every push to `main`; may be unstable.
- **test**: deploys when a `vX.Y.Z` tag is pushed; must stay stable.
- **prod**: deploys the same tag after manual approval in GitHub.
- Work on a branch and open a PR. Never push straight to `main`, and never create release tags unless the user asks.

## Rules

- The server is the source of truth for the draft; clients never advance it. Draft/scoring rules live in `packages/domain` as pure functions.
- Scoring rules are data (versioned JSON ruleset), never code. The league's real values are still pending, so use the placeholder ruleset in 04 until they arrive.
- Never use DynamoDB Scan; every read is a GetItem or Query on a documented access pattern (doc 10 §3).
- Points are always derived from raw stats ⊕ overrides; never hand-write a points column.
- Enforce invariants in the database (conditional writes + transactions, doc 10 §4) and server-side; admin checks are server-side only.
- Every commissioner action writes an audit event.
- Never run `terraform apply` or touch AWS without the user's explicit go-ahead.
