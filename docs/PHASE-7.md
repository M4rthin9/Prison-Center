# Phase 7 — LINE + hardening

> **Done when:** an existing password account links to LINE and receives a
> push; restore-from-backup rehearsed and documented.

Verified against the seeded database: a relative signed in with phone and
password links a LINE identity onto their existing row, logs back in with the
ID token alone and gets the same session shape, and unlinks without losing the
password login. A forgotten password is recoverable without staff through a
six-digit OTP. Every mutating route sits under a per-IP ceiling. The PDPA
retention job reports what it would remove and removes nothing until the
windows are signed off. The restore drill and the runbook exist as scripts and
prose, not as intentions.

## What exists

### Database (`0009_phase7_line_pdpa`)

One new table and five columns. The small footprint is the point: `customers`
has carried a nullable, unique `line_user_id` since Phase 0 precisely so this
phase would be an `UPDATE`, not a migration of identity.

`otp_challenges` — `purpose`, `target` (normalized phone), `reference`,
`code_hash`, `channel`, nullable `customer_id`, `attempts` / `max_attempts`,
`expires_at`, `consumed_at`, `ip`. The code itself is **never stored**, only
`sha256("<reference>:<code>")`, exactly like a refresh token — a database leak
cannot be replayed. `reference` is UNIQUE and binds the verify call to the
request that issued it, so a code from one challenge cannot be spent on
another.

`customers` gains `line_display_name`, `line_picture_url`, `line_linked_at`
(profile fields refreshed from the token on every login — LINE owns them, we
only mirror them), plus `closed_at` and `anonymized_at` for the PDPA path.

### LINE is a provider, not an account table

`LineIdTokenProvider` implements the same `AuthProvider` interface the password
provider has used since Phase 0, and `createSession()` downstream is unchanged.
The ID token is verified server-side against LINE's keys — **both** algorithms,
because which one arrives is not ours to choose: HS256 over the channel secret
for a web login, ES256 against the published JWKS for LIFF. Issuer, audience
and (when the client sent one) `nonce` are all checked.

The rule the design enforces: **a valid LINE token never creates an account.**
An unclaimed `sub` returns `LINE_NOT_LINKED` (404, its own error code), and the
app's answer is "sign in with your phone once, then link" — because an account
with no phone number cannot be reached by staff and cannot receive a password
reset. Linking is a single `UPDATE` on the row the relative is already signed
in as; the UNIQUE index on `line_user_id` is what makes "one LINE account, one
system account" the database's job rather than a service function's.

Unlinking clears the columns and leaves the password login untouched. Turning
the whole feature off is one setting (`features.line_login = false`) and loses
nothing.

### Push is layered on top of in-app, never in place of it

`createLineNotifier` wraps the in-app notifier rather than replacing it:

1. The in-app row is written **first and always**. A relative who never linked,
   or a push that fails forever, still sees the notification in the app.
2. The push itself is a `line.push` job. Nothing about a slip approval waits on
   `api.line.me`, and a transient 500 gets the queue's backoff.

The job id doubles as LINE's `X-Line-Retry-Key`, so a retry after a timeout
that actually delivered does not double-send. The outcome is written back onto
the same notification row (`sent_at` or `error`), so one row answers both "did
the relative see it?" and "did the push go out?". A permanent failure — the bot
was blocked, the user id is stale — is recorded and *not* retried; retrying it
would only burn the queue.

The rich menu is the six tiles of p.8 as LIFF URIs, created by
`pnpm --filter @pc/api rich-menu -- ./menu.png`. The previous menu is deleted
only *after* the new one is live, so a failed upload never leaves followers
with no menu at all.

### Self-service password reset

Phase 1's staff-assisted reset stays — it is the fallback for a relative whose
phone number changed, which is exactly the case an OTP cannot help with.

The new path issues a six-digit code with a reference, delivered over LINE if
the relative linked it and SMS otherwise (`console` writes to the outbox and is
the only adapter a dev machine or a test uses). Three properties matter:

- **Not a membership oracle.** A challenge is created and a response returned
  whether or not the number belongs to an account, with the same shape, the
  same channel and the same timing. Only `verify` can tell the difference, and
  it answers with the same 400 either way.
- **The attempt budget cannot be reset by asking again.** Wrong codes are
  counted on the challenge row, and the per-number throttle limits how many
  rows can exist (3 per 15 minutes).
- **A reset kills every session.** That is the entire point of a reset the
  account owner did not initiate.

`OTP_ECHO` returns the code in the response for local development, and
production refuses to boot with it on — the same guard shape as the dev
`JWT_SECRET` and `COOKIE_SECURE`.

### Rate limiting

Phase 0 shipped the SQLite counter and used it on login. This phase puts a
floor under everything: `globalWriteLimit` is mounted once for the whole API
and charges a per-IP budget for every non-`GET`. Reads are exempt on purpose —
a relative refreshing an order list is not the threat, and every report and
dashboard a staff member opens is a `GET`.

| Bucket | Budget | Block |
|---|---|---|
| every write | 240 / min | 2 min |
| login (per realm) | 20 / 15 min | 15 min |
| OTP request, per IP | 10 / 15 min | 30 min |
| OTP request, per number | 3 / 15 min | 30 min |
| OTP verify, per IP | 15 / 15 min | 15 min |
| LINE login/link | 30 / 15 min | 15 min |

Counters live in SQLite, so a block survives a restart — and a `--watch` reload
during development, which an in-memory limiter would silently reset.

### PDPA retention (decision #8)

The windows have been Settings Registry keys since Phase 0; this phase adds the
job that reads them, plus two switches in front of it. `pdpa.retention.enabled`
is off until the values have departmental sign-off, and `pdpa.retention.dry_run`
is on after that. **A run with either switch engaged reports exactly what it
would remove and removes nothing** — which is how the month of rehearsal the
plan asks for actually happens.

Seven actions, in one report:

| Action | What goes | What stays |
|---|---|---|
| `letters.content` | body text, attachments, scan images | who / when / status — the p.12 letter report still balances |
| `payments.slips` | slip images | `trans_ref`, amount, channel, status |
| `financial.records` | orders, payments, deposits past the window | — |
| `visits.bookings` | bookings past the window | — |
| `audit.logs` | rows past the window | — |
| `accounts.anonymize` | personal columns of a closed account | the row itself, so no financial record is orphaned |
| `housekeeping` | expired OTP challenges, dead rate-limit counters | — |

Anonymization, not deletion, is the load-bearing choice: `username` becomes
`deleted-<id>` (it is UNIQUE and NOT NULL, so it is replaced rather than
cleared), the personal columns are emptied, the password hash is replaced with
random bytes nothing can hash to, and `anonymized_at` is stamped so a second
pass finds nothing to do. Financial rows keep their foreign key.

`financial.records` deletes in dependency order inside one transaction with
foreign keys **on**: if anything outside the window still references a row
inside it, the whole run aborts rather than leaving a half-purged ledger.

A relative asks for closure from the profile screen (`POST /me/close-account`).
That blocks the account and cuts every session immediately; the scrub waits out
`pdpa.retention.closed_account_days` so a mistaken request can still be undone
by staff.

The job is enqueued daily at 03:00 Bangkok. The admin screen —
**ลบข้อมูลตามระยะเวลา**, `super_admin` only, because the windows are one
department-wide policy — previews and runs it.

### The customer app

`liff.svelte.ts` is the whole LINE dependency, and it is optional by
construction. `line.liff_id` comes from public settings; with no id configured
the SDK is never fetched and the app stays the ordinary mobile web SPA it has
been since Phase 1. A failed LIFF boot degrades to "the LINE button is
unavailable", never to a broken login screen.

- **Login** — the LINE button that has been rendered disabled since Phase 1 now
  works, and `LINE_NOT_LINKED` gets its own message pointing at the link flow.
- **`/forgot-password`** — two steps, request then verify, shown only when
  `features.self_service_reset` is on. The wording never confirms whether the
  number has an account.
- **Profile** — link/unlink with the LINE display name and avatar, and the PDPA
  closure request behind a confirm step.

## API surface

```
POST   /auth/line/login              { idToken, nonce? } → SessionResponse
POST   /auth/line/link               { idToken, nonce? } → LineLinkState   (auth)
DELETE /auth/line/link                                   → LineLinkState   (auth)
POST   /auth/password-reset/request  { phone }           → PasswordResetChallenge
POST   /auth/password-reset/verify   { reference, code, password } → 204
POST   /me/close-account                                 → 204             (auth)
GET    /admin/pdpa/retention/preview                     → RetentionReport (super_admin)
POST   /admin/pdpa/retention/run     { dryRun? }         → RetentionReport (super_admin)
```

`/auth/line/login` matches the shape §6 reserved for it in Phase 0, unchanged.

## Operations

`docs/RUNBOOK.md` is new and covers deploy, health checks, backup/restore, the
incidents that actually happen (locked database, wedged queue, a locked-out
office NAT, a full disk), the two-LINE-channel setup, the retention rollout and
the load test.

`docker/restore-drill.sh` restores the newest Litestream replica into a
throwaway directory and checks it five ways: non-empty file, `integrity_check`
`ok`, silent `foreign_key_check`, migration count matching the shipped
migrations, and a newest-audit-row lag under ten minutes. It never touches
`/data` — a drill that could damage production is a drill nobody runs. It runs
on the host, because `litestream` inside the container that holds the write
lock is a foot-gun; `sqlite3` was added to the API image for the runbook's
read-only checks.

`scripts/loadtest.ts` is dependency-free on purpose — `fetch` and a fixed
worker pool. It prints p50/p95/p99 and exits non-zero on any 5xx, which is the
failure it exists to catch: a 5xx under load means the single-writer assumption
broke. A 429 is a *result*, not a failure.

## Decisions

**LINE never creates an account.** The alternative — mint a customer row from
an ID token — produces accounts with no phone number, which staff cannot verify
against an inmate and cannot reset. The relative link (`customer_inmates`) is
the gate for all money, letters and visits, and it is verified by a human
against a phone number.

**Push is a job, not a call.** A relative's slip approval must not be slower
because LINE is having a bad afternoon, and a failed push must not roll back a
verification.

**The OTP response is deliberately uninformative.** The endpoint is
unauthenticated and takes a phone number; anything that varies with "is this
number registered" turns it into a directory of every relative in the
department.

**Retention defaults to doing nothing.** Two switches, both off, and a preview
that is a first-class screen rather than a log line. The failure mode of an
over-eager purge is unrecoverable.

**Rate limiting is a floor, not a policy.** One global per-IP write budget
mounted once, with tighter buckets declared by the routes that need them. A
limiter you have to remember to attach is a limiter that will be forgotten.

## Tests

`line.test.ts` mints real HS256 ID tokens with the channel secret, so the
verifier under test is the production one rather than a stub: linking onto the
signed-in account; a second relative refused the same `sub` (409); a token for
another channel and an expired token both refused (400); linking refused
without a session (401); LINE login returning the same session shape and the
same rotating-refresh cookie as a password login; an unclaimed `sub` answering
`LINE_NOT_LINKED` rather than creating an account; and unlinking leaving the
password login working while the LINE one stops.

`reset.test.ts`: a code issued and spent to set a new password, with the old
password stopping immediately; every existing session revoked (the refresh
cookie is dead even though the 15-minute access token is not); a wrong code
rejected and a spent code refused a second time; **identical responses for a
registered and an unregistered number**; and the per-number throttle biting on
the fourth request.

`pdpa.test.ts`: the preview covering all seven actions and deleting nothing;
`prison_admin` refused (403); a real purge refused while the switch is off
(403); a run falling back to dry-run; a closed account anonymized rather than
deleted, with the row and its keys intact and a second pass finding nothing to
do; and closure cutting the session immediately.

Two existing tests moved with the phase: the "job with no handler" case now
uses `order.cutoff_notify`, because `pdpa.retention` has a handler as of this
phase; and the week-grid "add a cell" case now picks a day the template has not
already materialized, instead of depending on which weekday the suite runs.

## Known gaps

- **SMS gateway is a shape, not an integration.** `OTP_ADAPTER=sms` posts
  `{ to, sender, message }` to `SMS_ENDPOINT` with a bearer key. The real Thai
  provider will want a different envelope; that is one function in `lib/otp.ts`.
- **The rich menu image is not in the repository.** The script takes a
  2500×843 PNG as an argument; the artwork is a design deliverable.
- **The restore drill has never run against a real replica**, because there is
  no VPS yet. The drill log in the runbook is empty and stays that way until it
  does.
- **Uploads still need their own backup schedule.** Litestream covers the
  database only, and the runbook says so in the first table.

## Next

Nothing in the phase plan. What is left is operational: stand up the VPS, run
the drill for real, get the retention windows signed off, and put a month of
dry-run reports in front of the department before flipping
`pdpa.retention.enabled`.
