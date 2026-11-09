# 11 — Sign-in, Invites & League Setup (Task 3)

Implements FR-1, FR-2 and part of FR-3/FR-4 from [01](01-requirements.md), on the storage in [10](10-dynamodb-data-model.md) and the stack in [09](09-aws-architecture.md). Draft order, draft time and the ruleset lock come later (tasks 6 and 8).

**Done when** (on DEV): the commissioner creates invite links for the 2026 season; each manager opens a link, enters their email, signs in with an emailed code and names their team; League home shows all teams (x/9). The commissioner can rename teams and revoke unused invites.

## 1. Roles & bootstrap

- The first commissioner is created by an admin script (there's no public sign-up):
  `pnpm admin bootstrap-league --env <local|dev|test|prod> --email <email> --league "<name>" --year 2026`
  1. Ensures a Cognito user for the email exists and can use email OTP (§3.3). Skipped for `local`.
  2. Writes `USER`, `LEAGUE`, `MEMBER` (role `commissioner`), `SEASON#<year>` pointer, season `META` (status `setup`), `DRAFT` (status `scheduled`, `currentPick = 1`) and an `AUDIT` item. Idempotent: re-running for the same league/year changes nothing.
- The commissioner may also manage a team (08 Q11 default). They join their own season through an invite like everyone else.
- Server-side authorization helpers: `requireMember(leagueId)` and `requireCommissioner(leagueId)`; a season resolves to its league via season `META`.

## 2. Data model additions (amends doc 10 §2)

| Entity | Keys | Notes |
|---|---|---|
| Invite | `pk = INVITE#<token>`, `sk = META`, **`gsi1pk = SEASONINV#<seasonId>`, `gsi1sk = <createdAt ISO>`** | Adds `createdBy`, `createdAt`, `pendingEmail?` (bound at register), `usedBy?`, `usedAt?`, `revokedAt?`, `teamId?`. `expiresAt` = createdAt + 14 days (epoch seconds, TTL). |
| Team owner marker | `pk = SEASON#<seasonId>`, `sk = TEAMOWNER#<userId>` | `teamId`. Enforces **one team per user per season** via `attribute_not_exists`. |
| User | (unchanged) | `displayName` defaults to the email local-part. |

New access pattern **A12**: invites for a season → `Query gsi1 gsi1pk = SEASONINV#<seasonId>`.

Invite token: 32 random bytes, base64url (43 chars). Never logged.

## 3. Authentication

### 3.1 Web (real users)
- **Amplify Auth v6** (`aws-amplify/auth`), configured at startup from `/config.json` (`cognitoUserPoolId`, `cognitoClientId`).
- Sign-in: `signIn({ username: email, options: { authFlowType: "USER_AUTH", preferredChallenge: "EMAIL_OTP" } })` → code screen → `confirmSignIn({ challengeResponse: code })`. Sign-out in the header. Amplify handles token storage and refresh.
- API calls send `Authorization: Bearer <ID token>`. The API verifies **ID tokens** (`aws-jwt-verify`, `tokenUse: "id"`, audience = client id) and reads `sub` + `email`.
- Routes other than `/signin` and `/join/:token` require a session and redirect to `/signin?next=…`.

### 3.2 Local dev (no Cognito)
- When `COGNITO_USER_POOL_ID` is unset **and** `APP_ENV=local`, the API accepts `X-Dev-User-Email` and derives a stable fake `sub` from it (`local-<sha256(email) first 16 hex>`). Without the header it falls back to `dev@local.test`. This path must be impossible in AWS: the code checks `APP_ENV === "local"` explicitly.
- The web app, when `config.env === "local"`, replaces the OTP flow with a "Dev sign-in" form (email only) that stores the email in `localStorage` and sends the header.

### 3.3 Making admin-created users OTP-ready
Cognito users created with `AdminCreateUser` start in `FORCE_CHANGE_PASSWORD`, which blocks passwordless sign-in. So the server/script:
1. `AdminCreateUser` (`MessageAction: SUPPRESS`, attributes `email`, `email_verified=true`) if `AdminGetUser` says the user doesn't exist.
2. `AdminSetUserPassword` with a **random 32-char password, `Permanent: true`**, immediately discarded. The user is now `CONFIRMED`; real users never learn a password and sign in only by email code.

### 3.4 Test users (DEV/TEST only, never PROD)
Per the owner's rule: the only real account used for testing is the owner's own. Everything else uses generated test users.
- `pnpm admin test-users create --env <dev|test> [--count 9]`: creates `dnp-test-01@example.com` … `-09@example.com` (RFC 2606 domain, so no email is ever delivered) via §3.3, but with **known random passwords**, and adds them to the Cognito group `test-users`. It stores `[{email, password}]` as an SSM SecureString `/dnp/<env>/test-users` (overwritten). It never prints passwords.
- `pnpm admin test-users delete --env <dev|test>`: removes those Cognito users and the SSM parameter.
- `pnpm admin test-league seed|reset --env <dev|test>`: bootstraps a separate league **"Test League"** with `dnp-test-01` as commissioner, invites and joins test users 02–09 (and 01) through the real API endpoints, so the owner's real league is never touched. `reset` deletes every item in the Test League's partitions (league, season, invites, user profiles of test users) by Query + BatchWrite, never Scan.
- Test users sign in by **password** (`USER_AUTH` with `preferredChallenge: "PASSWORD"`), and only from scripts/tests (Node, `@aws-sdk/client-cognito-identity-provider` `InitiateAuth`). The web UI has no password form.
- Every admin script **refuses `--env prod`** for test-user and test-league commands. Terraform creates the `test-users` group only when `!is_prod`.
- `pnpm smoke --env dev`: signs in as test users, calls the API end to end (me, invites, register, accept, rename, revoke), and asserts results against the Test League.

## 4. API (all under `/api`; JSON; errors `{ error: { code, message } }`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /me` | user | `{ user: {userId, email, displayName} \| null, leagues: [{ leagueId, name, role, seasons: [{ seasonId, year, status }] }] }`. A signed-in user with no `USER` item gets `user: null, leagues: []`. |
| `GET /seasons/:seasonId` | member | `{ season: {seasonId, leagueId, leagueName, year, status}, teams: [{ teamId, name, managerUserId, managerDisplayName }], myTeamId \| null, myRole, maxTeams: 9 }` |
| `GET /seasons/:seasonId/invites` | commissioner | `[{ token, url, status: "open"\|"pending"\|"used"\|"revoked"\|"expired", pendingEmail?, usedByDisplayName?, createdAt, expiresAt }]` |
| `POST /seasons/:seasonId/invites` | commissioner | Body `{ count: 1..9 }`. Rejects (409 `season_full`) if teams + open/pending invites + count > 9, or if the season status ≠ `setup`. Returns the created invites. Audited. |
| `DELETE /seasons/:seasonId/invites/:token` | commissioner | Revokes an unused invite (condition `attribute_not_exists(usedBy)`). Audited. |
| `GET /invites/:token` | public | `{ valid, reason?: "not_found"\|"expired"\|"used"\|"revoked", leagueName?, seasonYear?, pendingEmail? (masked, e.g. j***@gmail.com) }` |
| `POST /invites/:token/register` | public | Body `{ email }`. Valid + unused invite only. Binds `pendingEmail` (condition: not set, or equal to the same normalized email, so a link can't mint accounts for many emails). Makes the Cognito user OTP-ready (§3.3; skipped locally). Returns `{ ok: true }`. Emails are normalized with trim + lowercase. |
| `POST /invites/:token/accept` | user | Body `{ teamName }` (1–40 chars, trimmed). The caller's email must equal `pendingEmail`. One transaction (10 §4.5 extended): update `INVITE` (`usedBy`, `usedAt`, `teamId`; condition unused, not revoked, not expired, `pendingEmail = :email`), put `USER` if absent, put `MEMBER` (role `manager`) if absent (the commissioner keeps their role), put `TEAM`, put `TEAMOWNER#<userId>` (condition not exists → 409 `already_has_team`), put `AUDIT`. Returns `{ seasonId, teamId }`. |
| `PATCH /teams/:seasonId/:teamId` | team owner or commissioner | Body `{ name }`. Audited when done by the commissioner. |

Shared request/response types live in a new package **`@dnp/contract`** (TypeScript types + zod schemas), used by the API (validation) and the web (typing). Team names must be unique within a season (case-insensitive), checked in the accept/rename handlers by reading the season's teams first. Rare races are acceptable at this scale.

## 5. Web screens

| Route | Content |
|---|---|
| `/signin` | Email → "Send code" → 6-digit code → signed in → `next` or `/`. Clear errors for wrong/expired code; "resend code". Dev sign-in form when `env=local`. |
| `/join/:token` | Shows "Join **{league} {year}**". If not signed in: email → register → code → then the team-name form. If signed in: the team-name form directly. Invalid/used/expired links show a friendly message. After accept → `/`. |
| `/` League home | Not a member: "Ask your commissioner for an invite link." Member: season card (year, status), teams list with `n/9`, "Your team: X" with rename, link to Commissioner for commissioners. |
| `/commissioner` | Commissioner only: "Create invite links" (count), table of invites with status, copy-link button, revoke; teams table with rename. |
| Header | App name, nav (Home, Draft room, Standings, Rules, Commissioner if commissioner), signed-in email + Sign out. |

Mobile-first, using the existing layout shell and color tokens. Loading and error states everywhere; no blank screens.

## 6. Infrastructure changes
- `http` Lambda IAM: `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword` on the env's user pool ARN.
- Cognito group `test-users` (`aws_cognito_user_group`) only when `!is_prod`.
- No new env vars (`COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` are already set).

## 7. Testing
- **Unit/integration (DynamoDB Local):** invite create/limit/revoke, register binding rules, accept transaction (happy path, wrong email, used, revoked, expired, already has team, duplicate team name), authorization (non-member 403, manager on commissioner routes 403), `/me` shapes.
- **Web (vitest + testing-library):** sign-in two-step flow with Amplify mocked; join flow states; commissioner invite table.
- **Local end-to-end:** Playwright against `pnpm dev` using dev sign-in (no credentials needed): commissioner creates invites → a second browser context joins → League home shows 2/9.
- **DEV smoke:** `pnpm smoke --env dev` with test users (§3.4).
- **Owner check:** the owner signs in on DEV with their own email to confirm real OTP delivery. This also answers the open SES question in 09 §7.

## 8. Implementation notes (decisions made while building)
- `APP_ENV` accepts `local | dev | test | prod`.
- **Invite links are built by the web app** as `window.location.origin + "/join/" + token`. Behind CloudFront the API sees the execute-api Host, so the API's `url` field is only best effort (`PUBLIC_BASE_URL` → `X-Forwarded-Host` → `Origin`/`Referer` → Host).
- Invite list/create return bare `InviteView[]`; `expiresAt` in API responses is ISO; `pendingEmail` is unmasked for the commissioner (masked only on the public `GET /invites/:token`). `PATCH` team returns `{teamId, name}`; revoke returns `{ok: true}`.
- Accept also requires season status `setup` (409 `season_not_setup`) and pre-checks `teams < 9`.
- New error code `invite_bound` (409): registering a different email on an already-bound invite.
- `TEAM.draftPosition` is nullable until the draft order is set (task 6). Bootstrap writes no ruleset item yet (task 8); `DRAFT.pickSeconds` starts null.
- The 9-team limit check on invite creation is read-then-write (not atomic); the accept transaction is the real guard.
- The season pointer item copies `status` from season `META`, so any later status change must update both.
- `ensureCognitoUser` also repairs users stuck in `FORCE_CHANGE_PASSWORD` / `RESET_REQUIRED`.
- `pnpm smoke` resets the Test League first and needs direct table access (run with admin AWS credentials). `test-league reset` refuses unless every member is a `dnp-test-NN@example.com` user.
