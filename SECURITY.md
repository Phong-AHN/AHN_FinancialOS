# Security

AHN Financial OS holds a company's bank connections, payroll figures and full
transaction ledger. This document is the record of what was audited, what was
found, what was fixed, and — the part most security documents leave out — what
is still weak and why.

Status: **1 September 2026**. Audited and hardened against the running
application, not against a checklist.

---

## What an attacker would be after

Worth naming, because it decides what matters:

1. **The integration tokens.** QuickBooks, Plaid, Stripe and VietinBank
   credentials sitting in `integrations`. These are live access to AHN's money
   and, for Stripe, the ability to move it.
2. **The payroll figures.** Individual compensation, restricted by spec §23.
3. **The ledger itself.** Every counterparty, contract value and bank balance.
4. **The audit trail.** Not to read — to *rewrite*, so a change looks like it
   never happened.

Everything below is ordered by which of those it protects.

---

## Findings from this audit

Five real issues. Each was found by testing the running application, not by
reading a list of common vulnerabilities.

### 1. Open redirect in the sign-in callback — fixed

**Severity: high.** `src/app/api/auth/callback/route.ts` redirected to
`` `${origin}${next}` `` with `next` taken straight from the query string.

`?next=//evil.com` produces `https://ourapp.com//evil.com`. Every browser reads
a leading `//` as protocol-relative and follows it off-site.

Why this grade of bad: the victim clicks a sign-in link, **authenticates
successfully against the real application**, and is then handed to a page an
attacker chose — which can look identical and ask them to sign in again. In a
system holding a company's bank connections, an attacker-controlled landing page
immediately after a genuine login is a phishing primitive, not a nuisance.

Fixed by `safeNextPath()` in `src/lib/security.ts`, which rejects anything that
is not a single-slash relative path: absolute URLs, protocol-relative forms,
backslash variants some browsers normalise to slashes, and control characters
(a newline in a `Location` value is how one redirect becomes two responses).
Anything else falls back to `/`.

### 2. No CSRF protection on 20 state-changing routes — fixed

**Severity: medium-high.** The session lives in a cookie, so a form on another
site could cause a reader's browser to POST here with their credentials
attached. Every one of those routes moves financial state: re-categorising
transactions, attributing them to projects, changing alert thresholds, setting
an exchange rate that revalues the entire ledger.

`SameSite=Lax` blocks most of this on its own. It is also one browser default
away from not applying, and this is not a system where "mostly" is the right
standard.

`crossOriginRefusal()` now guards all 20. It trusts `Sec-Fetch-Site` where the
browser sends it, falls back to `Origin` then `Referer`, and allows requests
carrying none of the three — a browser form post always carries at least one, so
that case is a server-to-server call, not an attack.

Seven of those routes had handlers written as `POST()` with no `request`
parameter at all, so there was nothing to inspect. Their signatures were
changed. They included `/api/sync`, `/api/transactions/recategorize` and every
integration connect button — the most consequential routes in the application.

**Proven:** a cross-origin POST to `/api/projects` carrying a valid session
returns `403 Refused: Origin evil.com does not match localhost:3000`. The same
request from our own origin reaches validation normally.

### 3. No rate limiting anywhere — fixed on the routes that cost money

**Severity: medium.** Eight routes now carry limits, chosen by what each call
costs *somebody else* rather than by a uniform number:

| Route | Limit | Why that number |
|---|---|---|
| `/api/sync` | 4/min | Calls QuickBooks, Plaid, Stripe and VietinBank. Being throttled by a bank is not a state worth reaching by accident. |
| `/api/transactions/recategorize` | 4/min | Re-reads every uncategorised row and writes an audit entry per change. |
| `/api/alerts/test`, `/test-transaction` | 6/min | Delivers **real** messages to real Slack channels. The webhook identity cannot delete its own posts, so a loop leaves mess a person clears by hand. |
| Bank/aggregator connect routes | 6/min | Repeated failed authentication is exactly the pattern that gets an API key suspended. |
| `/api/import` | 10/min | Parses and inserts an uploaded file. |

**Proven:** seven rapid calls to `/api/transactions/recategorize` return
`200 200 200 200 429 429 429` with a `Retry-After` header.

### 4. `safeEqual` leaked the secret's length — fixed

**Severity: low.** The constant-time comparison used for the cron bearer token
and the OAuth `state` returned early when the lengths differed. Contents were
protected; length was not, and length is one of the two things an attacker needs.

`constantTimeEqual()` now HMACs both sides before comparing, so every comparison
is the same fixed width and the input's length reveals nothing about the
secret's.

### 5. No CSP, no HSTS — fixed

**Severity: medium.** Four headers were set. A Content-Security-Policy — the one
header that turns a script injection from a total compromise into a blocked
request — was absent, as was HSTS.

Now set on every response:

- **`Content-Security-Policy`** — `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, and
  `connect-src` pinned to this Supabase project. A browser made to run hostile
  script still cannot post the ledger to an address that is not on that list.
- **`Strict-Transport-Security`** — two years, subdomains, preload-eligible.
- `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`.
- `Permissions-Policy` extended to `payment`, `usb`, `interest-cohort`.
- `Cache-Control: no-store` on everything under `/api`, because every response
  there is a financial figure or an authenticated action, and a shared cache
  holding either is a disclosure waiting for the next reader.

---

## What was already right

Verified, not assumed. Each of these was tested against the running system.

**Row Level Security is the enforcement boundary, not the API layer.** Every
permission check in `tests/rls.integration.test.ts` runs with a real viewer's
token through the anon key — the way a browser or a script would. Service-role
queries prove nothing about policies, which is exactly how a payroll leak once
survived a passing test suite here (decision 41).

Ten checks currently pass: payroll hidden however it is filed, compensation
hidden under every wording, integration credentials hidden, audit log hidden,
writes refused, alert rules readable but not writable, project P&L readable but
never writable, rates and hours invisible, and — the control that stops the rest
passing for the wrong reason — the owner *can* see what the viewer cannot.

**The audit trail is append-only by construction.** `audit_logs` carries a
SELECT policy and an INSERT policy and no others, so with RLS enabled there is
no UPDATE or DELETE path at all. Proven with the owner's own token: both are
refused, and all 44 rows remain.

**Integration tokens are encrypted at rest.** AES-256-GCM with a random 12-byte
nonce, an authentication tag, a versioned ciphertext format and a key-length
check that refuses to start on a wrong-sized key. A leaked database dump is not
a leaked bank connection.

**Every service-role route is gated.** Thirteen routes use the key that bypasses
RLS. All thirteen are behind `ownerOnly` or the cron bearer token; the
QuickBooks callback additionally validates an OAuth `state` held in an httpOnly
cookie.

**OAuth `state` is validated.** The QuickBooks flow generates 24 random bytes,
stores them httpOnly, and compares on return.

**Secrets stay out of the client and out of the logs.** No `use client` file
reads anything but `NEXT_PUBLIC_*`. No `console.*` call in the connectors, crypto
or sync layers prints a token, secret or key. No `dangerouslySetInnerHTML`
anywhere.

**`.env.local` and `.env.production` are git-ignored.** Only `.env.example` is
tracked, and it holds nothing but URLs, environment names and a Slack channel.

**Every write is validated by schema.** Zod on every route body. Money arrives
as integer minor units and is rejected otherwise, so a contract value cannot
enter the system as a float.

**Cron routes refuse to run without a secret** rather than defaulting to open.

---

## A permission check that had never run, found after this audit

`loadProject` decided whether a reader could see labour cost from
`!peopleRes.error`, on the belief that RLS refuses a viewer outright. It does
not: a blocked select returns HTTP 200 with an empty list and no error, verified
with a real viewer token. The guard therefore never fired, and a viewer was
shown a **net profit computed from a labour cost of zero**, labelled as net, on
a project with hours logged against it.

Nothing leaked — the compensation itself stayed hidden, which is why the audit
above did not catch it. What escaped was the opposite failure: a confident,
authoritative, wrong number.

Fixed by taking the reader's capability from the session rather than inferring
it from a query result, defaulting to false so a caller that forgets gets “not
visible to you”. The platform behaviour is pinned by a test so the next
`!res.error` permission check is written down as a mistake before it is made.

**The general rule, now recorded:** an empty result can never decide a
permission. “There is nothing here” and “you may not see what is here” are
indistinguishable from the answer — that is what RLS is for. Only the capability
tells them apart, and only the database enforces it.

---

## Changing a role, after this audit

`/api/access` changes a role and links a Slack account, and it does NOT use the
service role. It runs on the caller's own session, so migration 0028's write
policy (`can_manage_people()`) and trigger are the whole boundary; the route
adds the audit entry and a readable error and nothing else.

The trigger refuses three things a policy cannot express: changing your own role
(any role that can promote itself makes the model advisory), demoting the last
owner, and altering `auth_id` or `email` — the last being the quiet escalation,
since `auth_id` is what maps a session to a role, and re-pointing it hands that
login the row's permissions.

Verified from outside with real tokens through the anon key: a viewer sees only
their own row and cannot promote themselves or anyone else; a CFO can change
others but not themselves; `auth_id` and `email` are refused. Nine assertions in
`tests/access.integration.test.ts`.

**Residual risk.** The last-owner branch is not exercised live, because doing so
would require the company to have no owner for the duration of the test. And a
single owner account remains a single point of failure the database cannot fix:
if it is lost, the way back is the SQL console. The page warns while only one
exists.

---

## Surface added after this audit: Slack slash commands

`POST /api/slack/commands` is a public endpoint that reads company-wide
financial data. It is worth stating its threat model explicitly rather than
letting it inherit the report above by silence.

**It is not authenticated by a session.** There is no Supabase session behind a
Slack request, so RLS cannot identify the caller and the route uses the service
role. That makes the checks in the route the *only* boundary, so they run before
a single row is read, and every command is read-only.

**Request signature.** Slack signs `v0:{timestamp}:{raw body}` with HMAC-SHA256.
Verification uses the raw bytes, compares in constant time over fixed-length
digests, and rejects any timestamp more than five minutes from now — in either
direction, so a forward-skewed clock cannot widen the replay window. With
`SLACK_SIGNING_SECRET` unset the endpoint refuses every request rather than
falling open. Failures answer `401` with no detail; naming the failed check
helps only the caller.

**Identity, which the signature does not provide.** A valid signature proves
Slack sent the request, not that the sender may see AHN's money. Slack workspace
membership is not AHN's permission model — contractors and agency staff share
that workspace. `users.slack_user_id` (migration 0026, uniquely indexed) maps a
Slack account to one app user; that user's role is checked against
`see_all_money` before anything is fetched. Unmapped ids are refused.

**Replies are ephemeral**, so an answer authorised for one person is not
delivered to a channel full of people it was not authorised for.

**Errors do not reach the chat window.** A stack trace names tables and columns
to a reader who has already been told they may ask questions here, so failures
are logged server-side and the reply says only that something went wrong.

Verified by driving the live endpoint: unsigned, wrongly-signed, replayed and
body-tampered requests each answered `401`; a correctly signed request from an
unlinked Slack id was refused by name; the same id linked to an `employee` was
refused for lacking the capability; linked to the owner it answered. The probe
restored every row it touched.

**Residual risk.** Anyone who obtains the signing secret can impersonate Slack,
and would then still need a linked Slack id to get an answer — so the secret
alone is not enough, which is the point of the second gate. Rotate it from the
Slack app's Basic Information page if it is ever exposed.

---

## What is still weak

The part a security document is usually silent about.

### The in-memory rate limiter does not survive scale

It is per-process. Two instances allow twice the limit; a restart forgets
everything. It is **not** a defence against a distributed attacker.

What it does defend against is the realistic failure: a loop, a stuck retry, or
one impatient person hammering a route that calls a bank. Those come from one
source and cost real money.

**Upgrade when this runs on more than one instance:** a shared limiter (Upstash
Redis, or a Postgres table). Until then the limit is a courtesy to upstream
providers, not a security control.

### The CSP still allows `'unsafe-inline'` for scripts

Next.js App Router inlines its hydration payload in a `<script>` tag. Removing
the allowance needs per-request nonces threaded through the document — a real
change, not a config line.

Consequence: a successful script injection would still execute. The rest of the
policy (`connect-src`, `object-src`, `base-uri`, `form-action`) limits what such
a script could *do* with the result, which is why it is still worth having.

**This is the single highest-value remaining hardening step.**

### One high-severity dependency advisory, unfixable without a major upgrade

`next@14.2.35` carries one high advisory. `npm audit fix` resolves it only by
moving to `next@16.3.4`, a major version.

Both named vectors —
[Image Optimizer DoS](https://github.com/advisories/GHSA-g5qg-72qw-gw5v) and
[request deserialization](https://github.com/advisories/GHSA-4342-x723-ch2f) —
are partly mitigated here: the Image Optimizer is **switched off** in
`next.config.mjs`, not merely unused, and this app defines no Server Actions.

**This is a scheduled upgrade, not an accepted risk.** Plan the move to Next 16
before production carries real money.

### Two passwords are known to have been typed into a chat window

The owner login and the Supabase database password, and they are currently the
**same string** — so one leak is two. This is the most concrete unfixed exposure
in the system and it cannot be fixed from the codebase.

**Rotate both before go-live.** Tracked in [docs/TODO.md](docs/TODO.md).

### There is no second factor

Sign-in is a password or an emailed magic link. For an account that can read
every bank balance and disconnect every integration, that is thin.

Supabase Auth supports TOTP MFA and enabling it is a project setting plus an
enrolment screen. **Recommended before production.**

### RLS is seven roles — closed, with one caveat

Spec §23's seven roles are implemented and enforced by Postgres: owner, CFO,
accountant, department lead, project manager, employee, read-only viewer. The
matrix lives in one capability function each, and
`tests/rbac.integration.test.ts` runs the real policies with a real token per
role.

Building it found a live hole: every write policy was `FOR ALL`, which in
Postgres covers SELECT, so a department lead could read every project in the
company while the scoped read policy beside it said otherwise. Fixed in
migration 0024 — see decision 79.

**The caveat:** scoping depends on data being set. A project with no
`owner_user_id` and no business unit is invisible to every scoped role, and a
business unit with no `lead_user_id` has no lead. Those are correct defaults —
nothing is granted by omission — but a department lead who sees nothing is more
likely misconfigured than locked out.

### Requests to VietinBank are unsigned

Their specification has a `signature` field but documents neither the algorithm
nor the payload to sign. Requests go unsigned rather than carrying an invented
signature. If the sandbox refuses them, the portal's signing documentation and
an RSA key pair are the missing pieces.

---

## Operating this safely

**Key rotation.** `ENCRYPTION_KEY` decrypts every stored integration token.
Rotating it means re-encrypting `integrations.access_token_enc` and
`refresh_token_enc`; the ciphertext carries a `v1.` prefix so a versioned
migration is possible. There is no rotation script yet — write one before the
first rotation, not during it.

**If a token is believed compromised:** revoke at the provider first
(QuickBooks, Plaid, Stripe, VietinBank), then delete the `integrations` row. The
provider's revocation is what stops access; deleting our row only stops us using
it.

**After any policy change**, re-run the RLS suite. A policy that quietly stops
restricting fails silently, and nothing else in the test suite would notice:

```
RLS_TEST=1 VIEWER_EMAIL=… VIEWER_PASSWORD=… npx vitest run tests/rls.integration.test.ts
```

**Before each deploy:** `npm audit --omit=dev`, `npm run typecheck`,
`npx vitest run`, and `npm run smoke` against the deployed URL.

**Reporting a vulnerability:** contact the repository owner directly. Do not
open a public issue.

---

## Verification log

Everything claimed above was executed against the running application on
1 September 2026.

| Check | Result |
|---|---|
| Cross-origin POST with a valid session | `403` — refused by origin |
| Same-origin POST | reaches validation normally |
| 7 rapid calls to a limited route | `200 200 200 200 429 429 429` |
| `?next=//evil.com` and three other forms | all resolve to our own host |
| Owner UPDATE on `audit_logs` | blocked by policy, 0 rows |
| Owner DELETE on `audit_logs` | blocked by policy, 44 rows intact |
| Viewer reading `people` / `time_entries` | 0 rows |
| Viewer writing a project | refused by policy |
| Service-role routes without a gate | none |
| Secrets in client bundles or logs | none |
| Live response headers | CSP, HSTS, COOP, CORP, XFO, Permissions-Policy present |
| Full test suite | 393 passed, 26 skipped |
| Seven roles, real tokens, real policies | 8 checks pass |
| All 12 pages as a signed-in owner | rendered |

Security tests live in `tests/security.test.ts` (20 cases) and
`tests/rls.integration.test.ts` (10 cases, gated behind `RLS_TEST=1`).
