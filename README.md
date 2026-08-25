# ศูนย์บริการระบบโปรแกรมจำหน่ายสินค้าเรือนจำ

Multi-tenant service portal for correctional facilities: commissary sales, money
deposits, e-letters, visit booking, payments and reports — all sliced by
`prison → แดน (zone)`.

Three deployables, one database, no cloud primitives. See [`Plan.md`](Plan.md)
for the full design, and the phase notes under `docs/` for what each phase
actually shipped: [`PHASE-0`](docs/PHASE-0.md) foundation,
[`PHASE-0B`](docs/PHASE-0B.md) inmate import, [`PHASE-1`](docs/PHASE-1.md)
catalog and orders, [`PHASE-2`](docs/PHASE-2.md) payments,
[`PHASE-3`](docs/PHASE-3.md) deposits, [`PHASE-4`](docs/PHASE-4.md) e-letters.

**Status: Phase 4 (E-letters) complete.** A relative buys a letter package on
the same payment spine as an order or a deposit, writes a letter that spends one
coupon from a ledger, staff batch-print it on A4 with a reply QR on every sheet,
and the inmate's handwritten reply is scanned back in and lands in the family's
app. Phase 5 (Visits) is not started.

---

## 1. Getting started

### Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | `>= 22.11.0` | the API relies on `--env-file-if-exists` and `--watch` |
| pnpm | `11.22.0` | pinned in `packageManager`; run `corepack enable` and pnpm matches automatically |
| Build toolchain | — | `better-sqlite3` and `sharp` install prebuilt binaries; nothing to compile on Windows/macOS/Linux |

Nothing external is required — no LINE channel, no LIFF ID, no tunnel, no S3,
no Docker.

### First run

```bash
pnpm i
cp apps/api/.env.example apps/api/.env          # the only .env that matters locally
pnpm db:migrate && pnpm db:seed
pnpm dev          # api :8787 · customer app :5173 · admin dashboard :5174
```

`apps/liff/.env` and `apps/admin/.env` are optional: an empty
`PUBLIC_API_BASE_URL` means same-origin, which the Vite dev proxy already
handles.

### Seeded accounts

Password is `password123` for all of them.

| Surface | Username | Notes |
| --- | --- | --- |
| Customer app :5173 | `0812345678` | linked to 2 inmates, verified |
| Customer app :5173 | `0845678901` | link request still pending — services locked |
| Admin :5174 | `superadmin` | all facilities, only role that can manage staff |
| Admin :5174 | `klp.admin` | เรือนจำกลางคลองเปรม only |
| Admin :5174 | `bkw.admin` | เรือนจำกลางบางขวาง only |

The seed also creates 4 shops, 30 products across 5 categories, 2 orders placed
through the real ordering service, and 4 payment channels — a PromptPay
credit-transfer (tag-29) rail per facility, a bank-transfer account, and an
inactive department-wide bill-payment (tag-30) channel waiting on a real Biller
ID.

### Commands

Run from the repo root; every task is a Turbo pipeline.

```bash
pnpm dev                         # all three, in parallel
pnpm build                       # build all three deployables
pnpm check                       # typecheck every workspace (tsc + svelte-check)
pnpm test                        # every test suite
pnpm db:migrate                  # apply migrations
pnpm db:seed                     # seed demo data
pnpm db:reset                    # drop the file, re-migrate — a 3-second operation
pnpm db:generate                 # generate a migration from schema changes
```

Scoped to one workspace:

```bash
pnpm --filter @pc/api test       # integration tests on a real in-memory SQLite
pnpm --filter @pc/api test:watch
pnpm --filter @pc/api db:studio  # Drizzle Studio
pnpm --filter @pc/admin dev      # just the dashboard
```

The OpenAPI document is generated from the same Zod schemas the API validates
with: <http://localhost:8787/api/v1/openapi.json>. Health check:
<http://localhost:8787/health>.

---

## 2. Layout

```
apps/api      Hono + Drizzle + SQLite. The only thing that touches the database.
apps/liff     SvelteKit SPA (adapter-static) — relatives. Plain web now, LINE in Phase 7.
apps/admin    SvelteKit SPA (adapter-static) — prison staff.
packages/contract  Zod schemas + typed fetch client shared by both front ends.
packages/ui        Tailwind v4 theme + shared Svelte 5 components.
packages/config    Shared tsconfig bases (node / svelte).
docker/       Compose + Caddy + Litestream for the single-VPS deployment.
docs/         Phase notes and decisions.
```

Inside `apps/api/src`:

```
db/          schema/ · migrations/ · seed/ · client.ts (pragmas) · migrate.ts · reset.ts
lib/         auth/ (providers, realms) · jobs/ · notify/ · storage/ · password.ts · hook.ts
middleware/  prison-scope.ts · error.ts · request-id.ts
modules/     auth · me · prisons · catalog · orders · admin · settings — one per feature
app.ts       route tree, CORS, OpenAPI document
env.ts       parsed + validated environment
```

`apps/liff` and `apps/admin` import only from `packages/*` — never from
`apps/api`. That is what keeps the three deployables actually separate.

---

## 3. Rules that are load-bearing

- **Money is `INTEGER` satang.** Never float, never decimal-as-text.
- **Timestamps are `INTEGER` unix epoch ms, UTC.** Converted to `Asia/Bangkok`
  at the display edge only. Buddhist-era years are formatting, never storage.
- **Ids are ULIDs** (`text`), generated in app code, never autoincrement.
- **One writer process.** Do not run the API under `cluster` or with multiple
  replicas — WAL allows many readers and exactly one writer.
- **Prison scope is middleware, not a `where` clause you remember to write.**
  Admin query helpers take a `PrisonScope`; forgetting it is a type error. Use
  `scopeFilter`, `resolvePrisonId` and `assertInScope` — nothing else.
- **Every setting is declared in code** (`modules/settings/registry.ts`) with a
  Zod schema and a default. Unknown keys are rejected on write.
- **The server owns the price.** A cart carries product ids and quantities;
  every line is re-priced from `products` on the way in.
- **Order lines snapshot the product.** Name, price, unit and category are
  copied onto the line, so a later catalog edit cannot rewrite a past order or
  last month's report. The same rule applies to the inmate's zone.
- **Lists paginate by keyset, never offset.** The cursor is opaque; a row must
  not appear twice because the catalog changed between pages.
- **The access token never touches `localStorage`.** It lives in the client
  closure; the refresh token is an httpOnly cookie. The LINE in-app webview
  shares storage across the whole origin.
- **Drizzle renders bare, unqualified column names inside `sql` templates.**
  A correlated subquery written that way compiles and returns silently wrong
  results. Use `count()`/`sum()` with a join and `groupBy`.

---

## 4. Contributing

### Working agreement

- Work in phase order (`Plan.md`). A phase is done when its "Done when"
  criterion is verifiable in a browser against the seeded database — not when
  the code compiles.
- Each phase generates **its own migration**. Do not front-load tables nothing
  reads, and never edit a migration that has already been committed.
- Record deviations from `Plan.md` in the phase note under `docs/`, with the
  reason. `docs/PHASE-0.md` is the format to copy.

### Before you push

```bash
pnpm check && pnpm test && pnpm build
```

All three must pass. `pnpm check` covers `tsc` for the API and contract, and
`svelte-check` for both front ends and `packages/ui`.

### Adding an API endpoint

The contract is the source of truth; work outward from it.

1. **Schema** — add or extend the Zod schemas in `packages/contract/src/*.ts`
   and export them from `index.ts`. Request *and* response.
2. **Route** — in `apps/api/src/modules/<feature>/routes.ts`, register an
   `OpenAPIHono` route using those schemas. Business logic goes in the sibling
   `service.ts`, not in the handler.
3. **Scope** — admin routes take a `PrisonScope` from `middleware/prison-scope.ts`
   and pass it to every query helper. No exceptions.
4. **Mount** — wire the route group in `apps/api/src/app.ts` under the right
   realm (`/api/v1/...` for customers, `/api/v1/admin/...` for staff). A module
   with both faces keeps them in `routes.ts` and `admin-routes.ts`
   (`modules/orders/` is the pattern to copy).
5. **Client** — add the typed method to `packages/contract/src/client.ts`.
6. **Test** — an integration test in `apps/api/test/`, against the real
   migrations. Cover the unhappy paths: wrong realm, cross-prison access,
   invalid input, and the rate-limited / locked-out case where one applies.

The OpenAPI document regenerates itself from step 2 — do not hand-write it.

### Changing the database

```bash
# 1. edit apps/api/src/db/schema/*.ts
pnpm db:generate                 # writes a new migration into db/migrations
pnpm db:reset && pnpm db:seed    # verify from empty
pnpm --filter @pc/api test
```

Conventions live in `schema/_shared.ts` (ULID ids, satang integers, epoch-ms
timestamps, `created_at`/`updated_at`) — extend that file rather than repeating
column definitions. Commit the generated SQL and the `meta/` journal together.

### Front-end conventions

- **Svelte 5 runes only** — `$state`, `$derived`, `$props`, `$effect`. No
  `export let`, no `$:`, no stores where a rune fits.
- Both apps are SPAs (`adapter-static`, `ssr = false`). There is no server
  runtime in front of them; do not add `+page.server.ts` or `load` functions
  that assume one.
- Shared components move into `packages/ui` once a second app needs them —
  not before.
- Styling is Tailwind v4 via `packages/ui/src/theme.css`. Add design tokens
  there rather than hard-coding colors in a component.
- All display formatting (money, dates, Buddhist-era years, phone numbers)
  goes through `packages/ui/src/format.ts`.

### Code style

Prettier is configured at the root (`.prettierrc`): no semicolons, single
quotes, 100 columns, no trailing commas, with `prettier-plugin-svelte`. Run it
before committing:

```bash
pnpm dlx prettier --write .
```

TypeScript is strict via `packages/config`. `any` and non-null `!` need a
comment explaining why.

### Commits

One logical change per commit, present tense, scoped by workspace:

```
api: reject settings writes for unknown keys
admin: show data scope in the sidebar shell
contract: add inmate import schemas
docs: phase 0b notes
```

Never commit: `apps/api/data/*` (the database, WAL/SHM files, uploads,
`outbox.log`, backups), any `.env`, or build output. `.gitignore` already covers
these — check `git status` before adding.

### Security-sensitive areas

Changes here need a second read and a test proving the old behaviour is still
enforced:

- `lib/auth/*`, `lib/password.ts` — Argon2id parameters, lockout, session
  rotation, refresh-replay revocation.
- `middleware/prison-scope.ts` — a scoping bug leaks one facility's data to
  another.
- `modules/settings/registry.ts` — the public-exposure flag decides what an
  unauthenticated caller can read.
- Anything touching `audit_logs` redaction or the PDPA retention windows.

---

## 5. Deployment

`docker/` holds the single-VPS deployment: Compose, Caddy (TLS + static files +
reverse proxy) and Litestream for continuous SQLite replication.

It is **written but not yet exercised** — validate on a scratch VPS and rehearse
a restore before go-live. Production checklist:

- `JWT_SECRET` — 32+ bytes, generated, never the dev default.
- `COOKIE_SECURE=1` behind TLS, and `COOKIE_DOMAIN` set.
- `CORS_ORIGINS` listing every deployed front end, exactly.
- One API replica. Litestream running, and a restore actually verified.
- `STORAGE_ADAPTER=s3` only after the S3 adapter is implemented — the stub
  fails loudly on purpose.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `SQLITE_BUSY` | A second writer. Only one API process may run — kill the stray `pnpm dev`. |
| App 401s on every call | `CORS_ORIGINS` missing the port, or `COOKIE_SECURE=1` on plain http. |
| Types from `@pc/contract` are stale | It builds to `dist/`. Run `pnpm --filter @pc/contract build`, or leave `pnpm dev` running — it watches. |
| Migration fails after a schema edit | `pnpm db:reset` — the dev database is disposable. |
| Login always fails for a seeded account | The database was migrated but not seeded. `pnpm db:seed`. |
