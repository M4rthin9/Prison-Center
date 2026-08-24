# Phase 0 — Foundation

> **Done when:** `pnpm dev` boots all three; a seeded relative logs into the
> customer app and a seeded admin logs into the dashboard.

Both criteria verified in a real browser against the seeded database.

## What exists

### Database (`apps/api/src/db`)

Schema §4.1 plus the cross-cutting tables (§4.7, §4.8), in one committed
migration — 17 tables:

| Group | Tables |
| --- | --- |
| Facility | `prisons`, `zones`, `work_divisions` |
| Inmates | `inmates`, `inmate_import_runs`, `inmate_import_rows` |
| Customers | `customers`, `customer_sessions`, `customer_inmates` |
| Staff | `staff`, `staff_sessions` |
| Cross-cutting | `settings`, `audit_logs`, `jobs`, `counters`, `notifications`, `rate_limits` |

Conventions enforced in `schema/_shared.ts`: ULID text ids, `INTEGER` satang,
`INTEGER` epoch-ms UTC timestamps, `created_at`/`updated_at` everywhere. Pragmas
(`foreign_keys`, WAL, `busy_timeout`, `synchronous=NORMAL`) are set on every
connection in `db/client.ts`, and `PRAGMA optimize` runs on graceful shutdown.

The DOC-sync columns (`external_id`, `external_source`, `synced_at`,
`sync_hash`, `is_locally_edited`, `deleted_at`) and the import-run tables are
already in place so Phase 0b adds a mapper, not a migration.

### Auth — both realms, one shape

`AuthProvider` (`lib/auth/provider.ts`) is the seam decision #7 asks for.
`createPasswordProvider(realm)` is the only implementation today;
`LineIdTokenProvider` slots in beside it in Phase 7 and nothing downstream of
`createSession()` changes.

- **Argon2id**, OWASP baseline (`memoryCost 19456, timeCost 2, parallelism 1`).
- **Phone as username** for customers, normalized to `0XXXXXXXXX`; `+66` and
  separator forms are converted at the edge.
- **Staff usernames are assigned**, and every staff account is created with
  `must_change_password = 1`.
- **Lockout**: 5 failures → 15 min, doubling per failure after that, capped at
  24h; every attempt lands in `audit_logs`. Per-IP throttling is separate and
  lives in `rate_limits`.
- **Sessions**: short-lived access JWT (15 min, in memory only) + rotating
  refresh token in an httpOnly `SameSite=Lax` cookie scoped to the auth path.
  Replaying a rotated token revokes every session that user holds.
- **Password reset**: staff-assisted one-time password, shown to the operator
  once and never retrievable.

`line_user_id` is nullable + unique on `customers` from day one, so Phase 7
linking is a single `UPDATE` rather than a second account.

### Prison scoping

`middleware/prison-scope.ts` returns `{kind:'all'}` for `super_admin` and
`{kind:'prison', prisonId}` for everyone else. `scopeFilter`, `resolvePrisonId`
and `assertInScope` are the only sanctioned ways to apply it, and admin query
helpers take the scope as a required argument.

### Adapters (both implementations in-repo, chosen by env)

| Adapter | Local | Production |
| --- | --- | --- |
| `StorageAdapter` | `local` → `data/uploads`, served at `/files/*` | `s3` (stub that fails loudly — implement before setting it) |
| `NotifierAdapter` | `console` → `data/outbox.log` + in-app row | `line` in Phase 7 |

### Settings Registry

Every key declared in `modules/settings/registry.ts` with a Zod schema, a
default, a scope (`global` / `prison`) and whether it is publicly exposed.
Unknown keys are rejected on write; a stored value that no longer satisfies its
schema falls back to the default with a warning rather than taking the API down.
All six `pdpa.retention.*` windows are seeded now, per decision #8, even though
the purge job is Phase 7.

### Jobs

`jobs` table + in-process scheduler. Claiming uses `BEGIN IMMEDIATE` so two
workers can never take the same row; failures back off exponentially and park as
`failed` once attempts are exhausted. One handler is registered
(`session.purge`); later phases call `registerHandler`.

### Front ends

Both are SvelteKit SPAs (`adapter-static`, `ssr = false`) built by Vite, using
Svelte 5 runes only.

- **Customer app** — bottom-nav phone shell, the p.13 menu with unverified
  services visibly locked, login / register / forced password change / profile
  with inmate-link requests, about + contact fed by public settings. The
  `เข้าสู่ระบบด้วย LINE` button is rendered disabled so the layout does not
  shift when Phase 7 lands.
- **Admin** — sidebar shell showing the caller's data scope, dashboard
  placeholder tiles, the customer-inmate verification queue, customer
  administration (one-time password, unlock), staff administration
  (`super_admin` only), and a Settings Registry editor.

## Deviations from the plan, and why

1. **`@node-rs/argon2` instead of `argon2`.** Same algorithm, same parameters,
   prebuilt binaries for every target we ship to — no node-gyp on Windows dev
   machines. Both realms go through `lib/password.ts`, so swapping it back is a
   one-file change.
2. **The admin dashboard is SvelteKit in SPA mode**, not Vite + `svelte-spa-router`.
   It is still a Svelte 5 SPA built by Vite and deployed as static files; using
   the same framework as the customer app removes a second routing model and a
   router whose Svelte 5 support is not settled.
3. **The full schema for §4.2–§4.6 is not written yet.** Phase 0 covers §4.1 and
   the cross-cutting tables; each later phase generates its own migration. This
   follows the plan's phasing rather than front-loading tables nothing reads.
4. **Fonts fall back to the system Thai stack.** Anuphan/Inter are declared
   first in `--font-sans` but no woff2 files are committed, because a CDN import
   would break the offline-first requirement. Drop the files into
   `packages/ui/fonts/` and add `@font-face` when they are licensed.
5. **`docker/` is written but not exercised.** No Docker on the build machine.
   Validate on a scratch VPS and rehearse a restore before go-live (§10).

## Gotcha worth remembering

Drizzle renders **bare, unqualified column names** inside `sql\`\`` templates.
A correlated subquery written that way compiles and returns silently wrong
results (`where "prison_id" = "id"` resolves both names inside the subquery).
Use `count()`/`sum()` with a join and `groupBy` instead — both places that hit
this are now written that way.

## Tests

`pnpm --filter @pc/api test` — 33 integration tests against a real in-memory
SQLite with the real migrations applied. Coverage includes: login for both
realms, phone normalization, timing-equal responses for unknown accounts,
registration, cookie flags, refresh rotation, refresh replay detection, logout,
lockout and admin unlock, staff-assisted reset with the forced change, staff
creation rules, immediate cutoff on deactivation, cross-prison refusal, the
settings registry (defaults, unknown keys, invalid values, prison override
precedence, global-key restriction), audit-log redaction, and the job claim
pattern.

## Next: Phase 0b — inmate data

Inmate CRUD, XLSX/CSV import with a dry-run diff, upsert by
`(external_source, external_id)`, conflict list, downloadable error report,
zone-transfer handling. **Get one real DOC export file first** (§13.1) — column
names, encoding (TIS-620 is still out there), and whether zone and work division
arrive as codes or free text. Build the mapper against the sample, not a guess.
