# ศูนย์บริการระบบโปรแกรมจำหน่ายสินค้าเรือนจำ — Build Plan

**Working name:** `prison-commerce` (CIDA)
**Constraints:** No Cloudflare. Three separate deployables (API / LIFF frontend / Admin dashboard). SQLite instead of MySQL. Everything must run fully offline on a laptop before anything is deployed.

---

## 1. What the diagram actually describes

Not an ecommerce site. It's a **multi-tenant service portal for correctional facilities** with five loosely-coupled business domains sharing one identity + payment spine:

| Domain | Diagram source | Nature |
|---|---|---|
| Commissary sales (ร้านค้า → สินค้า → คำสั่งซื้อ) | pp. 3, 13 | Catalog + cart + QR payment |
| Money deposit (การฝากเงิน) | p. 7 | Manual-review money movement |
| E-letters / Domimail (จดหมายอิเล็กทรอนิกส์) | pp. 6, 13 | Prepaid coupon quota + print queue + reply scan |
| Visit booking (การจองเยี่ยมผู้ต้องขัง) | pp. 8, 13 | Capacity-constrained slot booking |
| Payments + Reports + Dashboard | pp. 9, 11, 12 | Cross-domain read models |

Three surfaces, three different users:

1. **LIFF app** (inside LINE) — inmate relatives. Entry is `เปิดแอปไลน์ → เลือก LINE@ → เลือกเมนู` (p. 13). This is not a website; it's a LINE mini-app.
2. **Admin dashboard** — prison staff. Heavy tables, filters, XLSX exports, print queues, slip approval.
3. **API** — the only thing that touches the database.

The critical architectural fact hiding in the diagram: **everything is scoped by `prison → แดน (zone)`.** Shops, products, orders, letters, deposits, visit slots, and every single report is sliced by prison and zone. That scoping belongs in the schema and in the auth token, not in query params.

---

## 2. Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Runtime | **Node 22 LTS** | Native `node:sqlite` exists but is still unstable; Node 22 gives you `--env-file`, watch mode, and full better-sqlite3 support. Bun is tempting but its SQLite driver + Thai `ICU` collation story is weaker. |
| API framework | **Hono** on `@hono/node-server` | Same DX you already use, but here it's on Node so you keep synchronous SQLite, native `fs`, `sharp`, and worker threads — all of which the letter/report pipeline needs. |
| DB | **SQLite (better-sqlite3)** in WAL mode | Synchronous driver is a *feature* with SQLite: no connection pool, no async overhead, transactions are real closures. |
| ORM | **Drizzle ORM** | Compile-time typed, and its schema is portable to Postgres if this ever outgrows one box. Prisma's SQLite migration story is worse and it bundles a Rust engine. |
| Validation / contract | **Zod + `@hono/zod-openapi`** | One schema → runtime validation → OpenAPI spec → generated TS client for both frontends. Contract drift becomes a build error. |
| LIFF frontend | **SvelteKit** with `adapter-static` (SPA mode) | LIFF must boot client-side (`liff.init` needs the LINE JS SDK before anything renders). SSR buys nothing inside a LINE webview and complicates the token dance. Static build = deployable as plain files. |
| Admin dashboard | **Svelte 5 SPA** (Vite + `svelte-spa-router` or TanStack Router) | Behind auth, no SEO, no SSR. Vite dev server + proxy to API. |
| Charts | **ECharts** (`echarts` + custom Svelte action) | Dashboard (p. 11) needs stacked/period charts; ECharts handles Thai labels and has a solid XLSX-adjacent export story. |
| Tables | **TanStack Table (headless)** | Every admin screen is a filtered, paginated table. Headless keeps Tailwind styling in your hands. |
| Styling | **Tailwind v4** + Anuphan (Thai) / Inter (Latin) | Matches your existing design system. |
| Files | **Local disk adapter** (dev) → **MinIO/S3 adapter** (prod) | One `StorageAdapter` interface. Never import an SDK directly in a route. |
| Images | **sharp** | Slip uploads and letter photos need EXIF strip + resize + WebP before storage. |
| XLSX | **ExcelJS** | 7 report exports (p. 12), all needing Thai headers, column widths, merged title rows. `xlsx`/SheetJS community build is stale on styling. |
| PDF (letter print) | **Playwright → PDF** from an HTML template | Letters are printed in batches on A4 with Thai text. Playwright gives real Thai font shaping; `pdfkit`/`pdf-lib` fight you on Thai glyph clusters. |
| Jobs / cron | **In-process scheduler + a `jobs` table in SQLite** | No Redis. SQLite *is* the queue at this scale (single writer, `BEGIN IMMEDIATE` claim pattern). |
| Auth | **Username + password (Argon2id) for both realms.** LINE login added later behind the same session interface | Two totally separate auth realms. Never one users table with a `role` column doing double duty for both. |
| Monorepo | **pnpm workspaces + Turborepo** | |
| Tests | **Vitest** (unit/integration against a real in-memory SQLite) + **Playwright** (admin E2E) | |
| Deploy | **Docker Compose on one VPS/on-prem box**, Caddy in front, **Litestream** for continuous SQLite backup | Corrections data will almost certainly be required to stay on-prem/in-country. Plan for on-prem from day one. |

**Explicitly not used:** Redis, Kafka, Postgres, Next.js, Prisma, any managed cloud primitive.

---

## 3. Repository layout

```
prison-commerce/
├─ apps/
│  ├─ api/                    # Hono + Drizzle. The ONLY DB consumer.
│  │  ├─ src/
│  │  │  ├─ modules/          # vertical slices, one per domain
│  │  │  │  ├─ prisons/       # {routes,service,schema,queries}.ts
│  │  │  │  ├─ catalog/       # shops, categories, products
│  │  │  │  ├─ orders/
│  │  │  │  ├─ payments/      # PromptPay QR, slip intake, reconciliation
│  │  │  │  ├─ deposits/
│  │  │  │  ├─ letters/       # Domimail: credits, compose, print, reply
│  │  │  │  ├─ visits/
│  │  │  │  ├─ news/
│  │  │  │  ├─ users/         # relatives + inmate linking
│  │  │  │  ├─ reports/       # 7 XLSX generators
│  │  │  │  ├─ dashboard/     # read-model aggregates
│  │  │  │  └─ settings/      # Settings Registry
│  │  │  ├─ db/
│  │  │  │  ├─ schema/        # drizzle table defs, one file per domain
│  │  │  │  ├─ migrations/    # generated SQL, committed
│  │  │  │  └─ seed/          # dev fixtures (2 prisons, zones, products…)
│  │  │  ├─ lib/
│  │  │  │  ├─ promptpay/     # EMVCo TLV build + slip mini-QR decode
│  │  │  │  ├─ storage/       # StorageAdapter: local | s3
│  │  │  │  ├─ line/          # Messaging API push, ID-token verify
│  │  │  │  ├─ jobs/          # scheduler + handlers
│  │  │  │  └─ money.ts       # satang integers only
│  │  │  └─ middleware/       # auth, prison-scope, audit, rate-limit
│  │  └─ data/                # app.db (gitignored), uploads/
│  ├─ liff/                   # SvelteKit SPA — relatives
│  └─ admin/                  # Svelte 5 SPA — staff
├─ packages/
│  ├─ contract/               # Zod schemas + generated OpenAPI + typed fetch client
│  ├─ ui/                     # shared Svelte components, Tailwind preset, fonts
│  └─ config/                 # tsconfig, eslint, prettier bases
├─ docker/                    # Dockerfile per app, compose.yml, Caddyfile
└─ docs/                      # SPEC.md, CLAUDE.md, DESIGN.md, ADRs
```

Rule: `apps/liff` and `apps/admin` may import **only** from `packages/contract` and `packages/ui`. Neither ever imports from `apps/api`. That's what keeps three deployables actually separate.

---

## 4. Data model (SQLite)

Conventions:
- **Money is `INTEGER` satang.** Never float, never decimal-as-text.
- **Timestamps are `INTEGER` unix epoch milliseconds, UTC.** Convert to `Asia/Bangkok` at the display edge only.
- IDs: `TEXT` ULID (sortable, safe to expose, no cross-prison enumeration signal).
- Every table gets `created_at`, `updated_at`. Mutable business records get `created_by`, `updated_by`.
- `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`.

### 4.1 Facility & people

```sql
prisons(id, code, name_th, name_en, address, province, phone, is_active)
zones(id, prison_id→prisons, name, code, sort_order, is_active)          -- แดน
work_divisions(id, prison_id→prisons, name, code)                        -- กองงาน

inmates(id, prison_id, zone_id, work_division_id, inmate_code, full_name,
        status, released_at,
        external_id, external_source, synced_at, sync_hash,
        is_locally_edited, deleted_at)
  UNIQUE(prison_id, inmate_code)
  UNIQUE(external_source, external_id)

inmate_import_runs(id, prison_id, source, file_key, started_at, finished_at,
                   rows_total, rows_created, rows_updated, rows_skipped,
                   rows_errored, error_report_key, run_by)
inmate_import_rows(id, run_id, row_no, raw_json, result, message)
```

**Inmate master data is synced (decision #3).** Assume file-based first — the DOC system will realistically hand you an XLSX/CSV export long before it gives you an API.

- `external_id` is the DOC record key; `sync_hash` is a hash of the incoming row so unchanged rows are skipped cheaply on re-import.
- Import is **upsert by `(external_source, external_id)`**, never by name. Names re-spell, transfer, and collide.
- **Zone transfers are the main event.** An inmate moving `แดน 3 → แดน 7` mid-month must not retroactively rewrite last month's reports — which is exactly why order lines, letters, and deposits all snapshot `zone_id` at creation time rather than joining live to `inmates`.
- Rows in the DB but absent from the import are **not deleted**. Mark `status='released'` / `deleted_at` only when the feed explicitly says so, or after staff review. A truncated export file must never wipe live inmates.
- `is_locally_edited` protects fields staff corrected by hand from being stomped by the next import. Surface a conflict list in the import result rather than silently picking a winner.
- Every run writes an `inmate_import_runs` row plus a downloadable error report. Import without an audit trail is unusable when a family asks why their letter bounced.
- Keep the manual CRUD screens anyway — you will need them on day one, before the first feed arrives, and forever after for corrections.

customers(id, username UNIQUE, password_hash, full_name, phone,
          line_id_text, line_user_id NULL UNIQUE,
          failed_attempts, locked_until, password_changed_at,
          must_change_password, is_blocked, last_login_at)               -- ญาติผู้ต้องขัง
customer_sessions(id, customer_id, refresh_token_hash, expires_at,
                  ip, user_agent, revoked_at)
customer_inmates(id, customer_id, inmate_id, relationship,
                 verify_status, verified_at, verified_by)
  UNIQUE(customer_id, inmate_id)

staff(id, username UNIQUE, password_hash, full_name, email NULL, role,
      prison_id NULL, failed_attempts, locked_until, must_change_password,
      is_active, last_login_at)
  -- role ∈ super_admin | prison_admin | zone_staff | finance | letter_operator
  -- prison_id NULL only for super_admin
staff_sessions(id, staff_id, token_hash, expires_at, ip, user_agent, revoked_at)
```

**Auth decisions:**

- **Argon2id** (`argon2` package, `memoryCost: 19456, timeCost: 2, parallelism: 1` — the OWASP baseline). Not bcrypt: it caps input at 72 bytes and has no memory hardness.
- **Username = the relative's phone number** for customers. They already give it (p.8 `เบอร์มือถือญาติผู้ต้องขัง`), it's unique in practice, it's the only identifier a Thai family member reliably remembers, and it becomes the OTP channel for self-service reset later. Store normalized to `0XXXXXXXXX`, strip spaces and dashes, reject `+66` forms at the edge by converting them.
- **Staff usernames are assigned, not chosen**, and `must_change_password` is `1` on creation.
- **Lockout:** 5 failures → `locked_until = now + 15min`, exponential after that. Count per-username *and* per-IP; log every failure to `audit_logs`.
- **Password reset, Phase 1:** staff-assisted only. A `prison_admin` resets a customer to a one-time password with `must_change_password=1`. No email flow — most relatives don't have usable email, and an email reset link is a whole subsystem you don't need yet. Self-service SMS/LINE OTP is a Phase 7 item.
- **Registration:** open self-signup with phone + password + full name, but the account can only *browse*. Ordering, depositing, letters and visits all stay locked behind `customer_inmates.verify_status='verified'`, which a staff member approves. That's the real gate — the password just identifies who's coming back.

### 4.1b The seam for LINE login

Both realms issue the **same session shape** (short-lived access JWT + rotating refresh token row), from a single `AuthProvider` interface:

```ts
interface AuthProvider {
  kind: 'password' | 'line'
  authenticate(input: unknown): Promise<{ customerId: string } | AuthFailure>
}
```

Adding LINE later is then: implement `LineIdTokenProvider`, add `POST /auth/line/login`, and write `line_user_id` onto the existing `customers` row (link, don't create a duplicate account). Nothing downstream of `createSession()` changes. Keep `line_user_id` nullable and unique from day one so that migration is a single `UPDATE`.

`customer_inmates.verify_status` is the gate for everything sensitive: no deposit, no letter, no visit booking against an unverified link. The diagram (p. 4) shows the relationship field but not the verification step — add it, because money and letters flowing to the wrong inmate is the failure mode that kills the project.

### 4.2 Catalog & orders (p. 3)

```sql
shops(id, prison_id, zone_id NULL, name, shop_type, is_active)
  -- shop_type ∈ vocational_training | prison_products   (ร้านค้าฝึกอาชีพฯ / ผลิตภัณฑ์ราชทัณฑ์)
shop_hours(id, shop_id, weekday 0-6, opens_at 'HH:MM', closes_at 'HH:MM', is_open)
categories(id, name, sort_order, is_active)
products(id, shop_id, category_id, sku, name, description, price_satang,
         unit, image_key, product_type, is_active)
  -- product_type ∈ packaged_goods | food_beverage      (สินค้าบรรจุภัณฑ์ / อาหาร&เครื่องดื่ม)
  UNIQUE(shop_id, sku)

orders(id, order_no UNIQUE, customer_id, inmate_id, shop_id, prison_id, zone_id,
       subtotal_satang, discount_satang, total_satang,
       payment_status, fulfillment_status, note,
       ordered_at, paid_at, fulfilled_at, cancelled_at)
  -- payment_status    ∈ unpaid | awaiting_verify | paid | failed | refunded | expired
  -- fulfillment_status∈ new | preparing | delivered | cancelled
order_items(id, order_id, product_id, sku_snapshot, name_snapshot,
            unit_snapshot, unit_price_satang, qty, line_total_satang)
```

Snapshot the product fields onto the line item. The "รายงานสินค้าที่มีการขาย" report (p. 12) groups historical sales by product — if you join live to `products`, a price edit silently rewrites last month's report.

`order_no` format: `{PRISON_CODE}-{YYMM}-{SEQ}` generated inside the same transaction as the insert, via a `counters(scope, period, value)` row with an `UPDATE ... RETURNING`.

### 4.3 Payments (p. 9) — multi-rail, shared spine

Decision #4: **multiple payment rails, both PromptPay flavours.** That means the rail is configuration, not code, and a prison can have more than one active at a time.

```sql
payment_channels(id, prison_id NULL, rail, display_name, priority, is_active,
                 -- rail ∈ promptpay_bill_payment  (EMVCo tag-30)
                 --      | promptpay_credit_transfer (EMVCo tag-29)
                 --      | bank_transfer            (manual, account shown as text)
                 biller_id, terminal_suffix, ref1_mode, ref2_mode,   -- tag-30 only
                 target_type, target_value,                          -- tag-29 only
                 -- target_type ∈ mobile | national_id | ewallet_id | bank_account
                 bank_code, account_no, account_name,                -- display + slip matching
                 supports_purposes_json,                             -- ["order","deposit","letter_package"]
                 amount_salt_enabled, ttl_minutes)
  -- prison_id NULL = department-wide channel available to every facility

payments(id, payment_no UNIQUE, purpose, purpose_id,
         channel_id→payment_channels, rail,
         customer_id, prison_id,
         amount_satang, amount_salt_satang, charge_satang,
         status,
         qr_payload, qr_ref1, qr_ref2, expires_at,
         slip_image_key, slip_uploaded_at,
         trans_ref UNIQUE, sending_bank, receiving_bank,
         transfer_amount_satang, transferred_at,
         verified_by, verified_at, verify_method, reject_reason)
  -- purpose ∈ order | deposit | letter_package
  -- status  ∈ pending | awaiting_verify | succeeded | failed | expired | refunded
  -- verify_method ∈ manual | api_lookup | statement_match
```

`charge_satang` = `amount_satang + amount_salt_satang`. **This is the value in the QR and the value you match against the slip.** Keep the two separate so the order total stays clean in reports.

#### Why the two rails behave completely differently

| | Bill payment (tag-30) | Credit transfer (tag-29) |
|---|---|---|
| Reference fields | Biller ID + Ref1 + Ref2 carried in the payload | **None** |
| Who can receive | Juristic entity with a bank-issued Biller ID | Any PromptPay-registered mobile / national ID / account |
| Reconciliation key | Ref1 = `payment_no` → exact, automatable | amount + time window + `trans_ref` from the slip |
| Setup effort | Bank onboarding, weeks | Minutes |

This is the whole reason to support both. The Department can plausibly get a Biller ID for a central account; an individual prison's vocational-shop account almost certainly cannot, and will be on tag-29. Build tag-30 as the preferred rail and tag-29 as the one that actually works on launch day.

**Amount salting for tag-29.** With no reference fields, two relatives paying ฿470 within the same minute are indistinguishable. So when `amount_salt_enabled`, allocate a per-payment salt of 1–99 satang, unique among *currently pending* payments on that channel, and charge `฿470.37`. Release the salt back to the pool on settle or expire. Without this, tag-29 reconciliation is guesswork; with it, the charged amount is effectively a short-lived reference number. Show the exact satang amount prominently in the UI — relatives will otherwise round it.

**Rules that hold on every rail:**

1. `trans_ref` is **UNIQUE**, system-wide. One slip settles exactly one payment. This is the entire anti-fraud mechanism.
2. The slip's mini-QR payload is **unsigned plaintext**. It's a lookup key, never proof of payment.
3. Amount comparison is exact integer satang against `charge_satang`. No tolerance window.
4. Also assert `transferred_at` falls between `created_at` and `expires_at + grace`, and that `receiving_bank`/account matches the channel. A valid unused slip from an unrelated transfer is the obvious attack.
5. `verify_method='manual'` is the launch path (decision #2). The `SlipVerifier` interface stays in place from Phase 2 with a `ManualVerifier` implementation; adding an aggregator later is a new class plus a settings key, not a refactor.

**Channel selection** at checkout: filter by `prison_id` (or department-wide) → filter by `supports_purposes_json` → order by `priority`. If more than one is active, the customer picks; the choice is recorded in `payments.channel_id` so finance can reconcile per account.

### 4.4 Deposits (p. 7)

```sql
deposit_cards(id, customer_id, inmate_id, card_no, status, approved_by, approved_at)
deposits(id, deposit_no UNIQUE, customer_id, inmate_id, prison_id, zone_id,
         depositor_name, amount_satang, payment_id→payments,
         status, reviewed_by, reviewed_at, reject_reason, deposited_at)
  -- status ∈ pending | reviewing | completed | rejected   (p.7: อัปเดตสถานะ, กำลังตรวจสอบ, เสร็จสิ้น)
```

`ลงทะเบียนทำบัตรฝากเงิน` and `ยืนยันการฝากเงิน` (p. 13) are two distinct flows: card registration is a one-time approval, deposits are per-transaction.

### 4.5 E-letters / Domimail (pp. 6, 12, p.4 top-up history)

```sql
letter_packages(id, name, direction, price_satang, quota, is_active)
  -- direction ∈ to_prison | to_home ; from p.12: 100 THB → 10 letters, both directions
letter_credit_ledger(id, customer_id, inmate_id NULL, direction,
                     delta, balance_after, reason, ref_type, ref_id)
  -- reason ∈ purchase | consume | refund | admin_adjust | expiry
letters(id, letter_no UNIQUE, direction,
        sender_customer_id NULL, sender_inmate_id NULL,
        recipient_inmate_id NULL, recipient_customer_id NULL,
        prison_id, zone_id,
        body_text, status, batch_id NULL,
        printed_at, printed_by, dispatched_at, delivered_at,
        reply_to_letter_id NULL, rejected_reason)
  -- status ∈ draft | queued | pending_print | printed | dispatched | delivered | rejected
letter_attachments(id, letter_id, image_key, sort_order)
letter_batches(id, prison_id, zone_id, batch_no, letter_count, pdf_key,
               generated_by, generated_at)
```

Credits are a **ledger, not a counter**. Balance = `SELECT balance_after ORDER BY created_at DESC LIMIT 1`, written inside the consuming transaction. A bare `credits_remaining` integer column will drift the first time a print job fails halfway.

`แบบฟอร์มตอบกลับ (แบบจดหมายสแกน)` (p. 6): the printed letter carries a QR encoding `letter_no`; the inmate's handwritten reply is scanned, the QR is read, and the scan attaches to a new `letters` row with `direction='to_home'` and `reply_to_letter_id` set. Design the print template around that QR from day one.

### 4.6 Visits (pp. 8, 12) — admin-defined rounds

Decision #6: **staff enter the schedule by hand — which รอบ, which แดน, which day.** So the p.12 weekday grid becomes a *starting template*, not the model. The model is a materialized day-by-day calendar the admin edits directly.

```sql
visit_rounds(id, prison_id, round_no, label, session, start_time, end_time,
             sort_order, is_active)
  -- e.g. round_no 1, label 'รอบที่ 1', session 'morning', 09:00–09:40
  -- session ∈ morning | afternoon   (เช้า / บ่าย, kept for reporting)
  UNIQUE(prison_id, round_no)

visit_schedule_templates(id, prison_id, weekday 0-6, round_id, zone_id,
                         capacity, is_active)
  -- optional recurring pattern; seeds p.12's grid, e.g. Mon AM → แดน 6

visit_schedule_days(id, prison_id, date, round_id, zone_id,
                    capacity, booked_count DEFAULT 0,
                    is_closed, note, source, created_by)
  -- source ∈ template | manual
  UNIQUE(prison_id, date, round_id, zone_id)
  CHECK(booked_count >= 0 AND booked_count <= capacity)

visit_bookings(id, booking_no UNIQUE, customer_id, inmate_id,
               prison_id, zone_id, schedule_day_id→visit_schedule_days,
               visit_date, round_id, session, start_time, end_time,
               visitor_name, contact_phone, line_id_text,
               status, cancelled_reason, cancelled_at, checked_in_at)
  -- status ∈ pending | confirmed | cancelled | checked_in | no_show
  UNIQUE(inmate_id, visit_date)     -- one visit per inmate per day
```

**How it works in practice:**

1. Admin defines the prison's **rounds** once — how many per day, what times, morning or afternoon. Different facilities will have different numbers of rounds; that's why it's per-prison data.
2. Admin optionally defines a **weekly template** (the p.12 grid: Mon AM → แดน 6, Mon PM → แดน 3, 10, and so on).
3. A job **materializes** the template into `visit_schedule_days` N weeks ahead (`visit.horizon_weeks`, default 4). Running it again is idempotent and never touches rows with `source='manual'`.
4. Admin then **edits any day directly** in a calendar grid — change the zone on a round, bump capacity, close a date for a holiday or lockdown, add an extra round. Manual edits win, permanently.

**Booking reads `visit_schedule_days` only.** Never the template, never a weekday rule evaluated at request time. One row = one bookable cell, with its own capacity and counter. That's what makes the manual override trivially correct and the capacity check a single-row update:

```sql
BEGIN IMMEDIATE;
UPDATE visit_schedule_days
   SET booked_count = booked_count + 1
 WHERE id = ? AND is_closed = 0 AND booked_count < capacity;
-- 0 rows changed → slot full or closed, roll back
INSERT INTO visit_bookings (...);
COMMIT;
```

The `CHECK` constraint is the backstop if anyone ever writes that update carelessly. Cancellation decrements in the same transaction as the status change.

**Admin UI:** a week grid, rounds down the left, dates across the top, each cell holding zone + `booked/capacity`, click to edit, right-click to close. Plus a "generate next 4 weeks from template" button and a bulk close-date action. This screen will be used daily — it deserves real design attention, more than any other admin page in the system.

### 4.7 News, settings, audit

```sql
news(id, title, slug UNIQUE, cover_image_key, body_html, status,
     published_at, author_staff_id)

settings(key PRIMARY KEY, value_json, scope, scope_id, updated_by, updated_at)
  -- Settings Registry: every key declared in code with a Zod schema + default.
  -- Unknown keys rejected on write; missing keys fall back to the declared default.
  -- Seeded keys: shop.hours, visit.horizon_weeks, visit.booking_cutoff_hours,
  --              letter.packages, payment.channel_default, payment.qr.ttl_minutes,
  --              payment.salt.enabled, order.cutoff_time, inmate.sync.source,
  --              pdpa.retention.*, line.rich_menu_id, ...
audit_logs(id, actor_type, actor_id, action, entity, entity_id,
           before_json, after_json, ip, created_at)
```

Audit everything that touches money, letters, or inmate records. In a corrections context this is not optional and it is far cheaper to add now than to retrofit.

### 4.8 Jobs

```sql
jobs(id, kind, payload_json, run_at, status, attempts, max_attempts,
     locked_at, locked_by, last_error, created_at, completed_at)
  -- kinds: line.push | letter.batch_pdf | report.generate | payment.expire
  --        visit.reminder | order.cutoff_notify
```

Claim pattern: `BEGIN IMMEDIATE; SELECT ... WHERE status='pending' AND run_at<=now LIMIT 1; UPDATE ... SET status='running'; COMMIT;`

---

## 5. Indexes that matter

Derived directly from the filters on each screen:

```sql
CREATE INDEX idx_orders_prison_date   ON orders(prison_id, ordered_at DESC);
CREATE INDEX idx_orders_paystatus     ON orders(payment_status, ordered_at DESC);
CREATE INDEX idx_orders_customer      ON orders(customer_id, ordered_at DESC);
CREATE INDEX idx_products_shop_cat    ON products(shop_id, category_id, is_active);
CREATE INDEX idx_payments_status_date ON payments(status, created_at DESC);
CREATE INDEX idx_payments_purpose     ON payments(purpose, purpose_id);
CREATE INDEX idx_payments_pending_amt ON payments(channel_id, status, charge_satang);
CREATE INDEX idx_letters_print_queue  ON letters(prison_id, zone_id, status, created_at);
CREATE INDEX idx_deposits_review      ON deposits(prison_id, status, deposited_at DESC);
CREATE INDEX idx_visit_days_lookup    ON visit_schedule_days(prison_id, date, zone_id);
CREATE INDEX idx_visit_bookings_day   ON visit_bookings(schedule_day_id, status);
CREATE INDEX idx_inmates_external     ON inmates(external_source, external_id);
CREATE INDEX idx_credit_ledger_latest ON letter_credit_ledger(customer_id, direction, created_at DESC);
```

Run `EXPLAIN QUERY PLAN` on every report query during Phase 5. SQLite will happily full-scan and you won't notice until year two.

---

## 6. API surface

Base: `/api/v1`. Two auth realms, two route trees.

### Public / customer — `Authorization: Bearer <access-jwt>`

```
POST   /auth/register                { phone, password, fullName } → session
POST   /auth/login                   { username, password } → access jwt + refresh cookie
POST   /auth/refresh                 rotating refresh token
POST   /auth/logout                  revokes the refresh row
POST   /auth/change-password         { current, next }  (required when mustChangePassword)
POST   /auth/line/login              { idToken }        ← Phase 7, same response shape
GET    /me                           profile + linked inmates + credit balances
PATCH  /me                           name, phone, LINE ID text
POST   /me/inmates                   request link to an inmate
GET    /prisons                      /prisons/:id  (name, address, zone count — p.2)
GET    /shops?prisonId&zoneId
GET    /categories
GET    /products?shopId&categoryId&q&cursor
POST   /orders                       cart → order (server re-prices, never trusts client)
GET    /orders?cursor  /orders/:id   ประวัติการสั่งซื้อ (p.13)
GET    /payment-channels?prisonId&purpose   available rails, ordered by priority
POST   /orders/:id/payment           { channelId } → { qrPayload, chargeSatang, expiresAt, paymentNo }
POST   /payments/:id/slip            multipart slip upload
GET    /payments/:id
POST   /deposits                     + slip
GET    /deposits?cursor
POST   /deposit-cards
GET    /letters?direction&cursor  /letters/:id
POST   /letters                      consumes 1 credit (transactional)
POST   /letter-packages/:id/purchase → payment
GET    /visits/availability?prisonId&inmateId&from&to
       → days[] { date, rounds[] { roundId, label, time, zoneId, remaining, closed } }
POST   /visits                       { scheduleDayId, inmateId, visitorName, phone }
DELETE /visits/:id                   cancel
GET    /news  /news/:slug
GET    /settings/public              shop hours, packages, contact
```

### Admin — cookie session + `prison_id` scope from `staff`

```
POST   /admin/auth/login  /logout  /me
GET    /admin/dashboard/summary?from&to     → orders | visits | letters | deposits (p.11)
CRUD   /admin/prisons /zones /work-divisions /inmates
POST   /admin/inmates/import                 multipart XLSX/CSV → dry-run diff
POST   /admin/inmates/import/:runId/apply
GET    /admin/inmates/import/:runId/errors.xlsx
CRUD   /admin/shops /categories /products
GET    /admin/orders?from&to&status&prisonId&zoneId&page
PATCH  /admin/orders/:id/fulfillment
CRUD   /admin/payment-channels
GET    /admin/payments?...            POST /admin/payments/:id/verify | /reject
GET    /admin/deposits?status         POST /admin/deposits/:id/review
GET    /admin/letters?status&zoneId
POST   /admin/letters/batches         → queue PDF job
POST   /admin/letters/:id/printed
POST   /admin/letters/scan-reply      multipart, QR-decoded
CRUD   /admin/visit-rounds
CRUD   /admin/visit-schedule-templates
POST   /admin/visit-schedule/generate  { from, weeks } → materialize, skip manual rows
GET    /admin/visit-schedule?from&to    week grid: rounds × dates × zones
PATCH  /admin/visit-schedule/:dayId     zone, capacity, close/open, note
POST   /admin/visit-schedule/bulk-close { dates[], reason }
GET    /admin/visits?date&roundId     POST /admin/visits/:id/status
CRUD   /admin/news
CRUD   /admin/customers
POST   /admin/customers/:id/reset-password   → one-time password, mustChangePassword=1
POST   /admin/customers/:id/unlock           → clears lockout
POST   /admin/customer-inmates/:id/verify
CRUD   /admin/staff  + /admin/staff/:id/reset-password   (super_admin only)
GET    /admin/settings  PUT /admin/settings/:key
POST   /admin/reports/:kind           → job id
GET    /admin/reports/:jobId/download → XLSX stream
```

**Prison scoping is middleware, not a `where` clause you remember to write.** `prisonScope(c)` returns `null` for `super_admin` and a `prison_id` otherwise; every admin query builder takes it as a required argument. Make it impossible to forget by typing the query helpers to demand it.

---

## 7. The seven reports (p. 12)

All ExcelJS, all async via the `jobs` table, all with a Thai title row + generated-at stamp + the filters used.

| # | Report | Grain | Key columns |
|---|---|---|---|
| 1 | รายงานการขาย | order | ลำดับ, วันที่, เลขคำสั่งซื้อ, จำนวนเงิน, สถานะชำระ, วันที่ชำระ, สลิป |
| 2 | สรุปการขาย | order line | + สินค้า, จำนวน, ราคา, รวม, ผู้ส่ง, เบอร์โทร, ผู้รับ, แดน, รหัส, หมายเหตุ |
| 3 | รายงานสินค้าที่มีการขาย | product × zone × work division | `GROUP BY sku` → e.g. `ชิฟฟอนเค้ก (50072) · นข.xx แดน 1 กองงาน xxx/68` |
| 4 | รายงานการเยี่ยม | booking | per prison, per zone, per month/year |
| 5 | รายงานจดหมายอิเล็กทรอนิกส์ | letter | outbound per prison, per zone, per month/year |
| 6 | รายงานการชำระเงิน | payment | succeeded vs failed, per prison, per month/year |
| 7 | รายงานสรุปยอดการฝากเงิน | deposit | per prison, per month/year |

Reports 3–7 are period aggregates. Write them as raw SQL with CTEs and keep them in `modules/reports/queries/*.sql` — Drizzle's query builder makes pivot-shaped SQL unreadable and these queries are the ones you'll be debugging against auditors.

Thai month/year grouping: store UTC, group with `strftime('%Y-%m', datetime(ts/1000,'unixepoch','+7 hours'))`. Buddhist-era years are a *formatting* concern; never store พ.ศ.

---

## 8. Customer app — plain web first, LINE later

With password auth, `apps/liff` starts life as an ordinary mobile web SPA. **No LINE channel, no LIFF ID, no HTTPS tunnel, no ngrok is needed for Phases 0–6.** That removes the single biggest external dependency from the whole build, which is the main reason password-first is the right call.

Phase 1 shape:

- Bottom-nav mobile SPA, viewport-locked, built to the p.14 screens. Same menu as p.13: ร้านค้า · จองเยี่ยม · การฝากเงิน · จดหมาย · ข่าวสาร · เกี่ยวกับเรา · ติดต่อเรา · ประวัติการสั่งซื้อ.
- Login screen: phone + password, with `เข้าสู่ระบบด้วย LINE` rendered as a disabled placeholder so the layout doesn't shift when it lands.
- Access JWT held in memory only (~15 min). Refresh token in an httpOnly `SameSite=Lax` cookie. Do **not** put the access token in `localStorage` — LINE's in-app webview shares storage across the whole domain and it's the easiest token to steal.
- On `401`, one silent refresh attempt, then bounce to login. On `must_change_password`, force the change screen before any other route resolves.
- QR display: `Save QR Code` (p.14) renders client-side from the payload string via `qrcode` onto a canvas → download or share.

When LINE goes in (Phase 7):

- Point a LIFF app at the same deployed URL. LINE accepts `http://localhost:<port>` for a *development* LIFF app; register a second dev LIFF ID for that. If the channel rejects it, `ngrok http 5173`.
- `liff.init()` → `liff.getIDToken()` → `POST /auth/line/login`. The API verifies the ID token against `https://api.line.me/oauth2/v2.1/verify` (check `aud` = channel ID, `iss`, `exp`), then issues the same session pair. **Never trust `liff.getProfile()` for identity** — it's client-side and forgeable.
- First LINE login for an existing account **links** (`customers.line_user_id = sub`) rather than creating a second account. Prompt for phone + password once to prove ownership; otherwise anyone who knows the relative's phone number gets a free duplicate.
- Wrap the app so `liff.isInClient()` toggles the LINE-only affordances (`shareTargetPicker`, rich menu deep links) and hides the login screen entirely.
- **LINE Messaging API push** (not LINE Notify — discontinued) for: payment confirmed, deposit reviewed, letter printed, visit reminder T-24h, order ready. Push requires `line_user_id`, so until Phase 7 those notifications are in-app only — the notification adapter should already be in place from Phase 0 with an `in_app` implementation.

---

## 9. Local-first development

Everything runs with no external service. One command.

```bash
pnpm i
pnpm db:migrate && pnpm db:seed     # 2 prisons, 10 zones, 40 products, 20 inmates,
                                    # 5 customers, orders/letters/deposits across 3 months
pnpm dev                            # turbo: api :8787 · liff :5173 · admin :5174
```

| Prod dependency | Local substitute |
|---|---|
| S3/MinIO | `StorageAdapter=local` → `apps/api/data/uploads`, served at `/files/*` |
| LINE login | Not needed — password auth is fully local. Seeded accounts in `db:seed`. |
| LINE push | `NotifierAdapter=console` — logs the payload, writes to `data/outbox.log` |
| Bank slip API | `SlipVerifierAdapter=manual` (the real fallback anyway) |
| Real payments | QR generated for real, verification stubbed to a "mark as paid" dev button |
| MySQL | SQLite `data/app.db`, WAL |

Rules that keep it honest:
- One `.env.example` per app, committed. `--env-file=.env` in Node 22, no dotenv package.
- Adapters are chosen by env var and both implementations live in the repo. If the local path diverges from prod behaviour, that's a bug in the interface.
- `pnpm db:reset` must be a 3-second operation. Deleting `app.db` and re-running migrations + seed is the fastest reset any database gives you — use it constantly.
- Integration tests open a fresh `:memory:` SQLite per suite and run the real migrations.

---

## 10. Deployment — single VPS (decision #5)

Pick a **VPS with Thai/in-country hosting**. Corrections data plus PDPA makes offshore hosting a fight you don't want; Thai providers with local DCs are cheap enough that it isn't a real trade-off. Start at **4 vCPU / 8 GB RAM / 160 GB NVMe**, which is generous for this load — SQLite's ceiling here is write concurrency, not hardware.

Docker Compose on that one box:

```
caddy      :80/:443 → TLS (auto), static file serving, reverse proxy
  ├─ shop.<domain>   → liff/customer static build
  ├─ admin.<domain>  → admin static build   (+ IP allowlist or WireGuard-only)
  └─ api.<domain>    → api:8787
api        node:22-slim, volume: /data (app.db + uploads)
litestream sidecar → continuous replication of app.db off-box
```

MinIO is optional and probably unnecessary — a mounted volume on the same box is simpler, and the storage adapter means you can move to S3 later without touching a route.

**Box hardening:**
- UFW: only 22, 80, 443. SSH keys only, root login off, `fail2ban` on sshd.
- Admin dashboard behind an **IP allowlist or WireGuard/Tailscale**, not just a login form. Staff access from fixed facility networks — use that.
- Separate mounted volume for `/data` so the DB and uploads survive a rebuild of the instance.
- Automatic security updates; pin the Node base image by digest.

**SQLite operations:**
- WAL + **one writer process**. Do not run the API with `cluster` or multiple replicas — that's the one thing that breaks this design. Vertical scale only.
- `PRAGMA optimize` on graceful shutdown; `VACUUM` monthly in a maintenance window.
- Backups: **Litestream continuous** to off-box object storage, **plus** a nightly `VACUUM INTO /backup/app-$(date).db` shipped off the VPS. Continuous replication protects against disk loss; the nightly snapshot protects against a bad migration, which is the more likely disaster.
- Uploads (slips, letter images) are **not** in the DB and are **not** covered by Litestream — `restic` or `rclone` them nightly on their own schedule. A restored database pointing at missing slip images is a compliance problem.
- **Rehearse a full restore onto a scratch VPS before go-live.** An untested backup is a rumour.
- Migration escape hatch: if concurrent writes ever bottleneck, Drizzle's schema moves to Postgres with a dialect swap and a dump. Keep the report SQL ANSI-ish so that path stays open.

---

## 11. Phased build order

| Phase | Scope | Done when |
|---|---|---|
| **0 — Foundation** | Monorepo, Drizzle schema §4.1, migrations, seed, contract package, **password auth for both realms** (register, login, refresh, logout, change-password, lockout, staff-assisted reset) behind the `AuthProvider` interface, prison-scope middleware, storage adapter, notifier adapter, audit log | `pnpm dev` boots all three; a seeded relative logs into the customer app and a seeded admin logs into the dashboard |
| **0b — Inmate data** | Inmate CRUD, XLSX/CSV import with dry-run diff, upsert by `external_id`, conflict list, error report, transfer handling | A DOC-shaped export imports twice with zero duplicates and a readable diff |
| **1 — Catalog + Orders** | Shops, categories, products, admin CRUD, customer browse + cart + order, order history, admin order list & fulfillment | A relative can place an unpaid order end to end |
| **2 — Payments** | `payment_channels` CRUD, **tag-30 and tag-29 QR generation**, amount salting, payment records, slip upload + sharp pipeline, mini-QR decode, `trans_ref` uniqueness, `ManualVerifier` + admin verify/reject queue, payment list (p.9) | Both rails settle an order manually; a duplicate slip and a wrong-amount slip are both rejected |
| **3 — Deposits** | Deposit cards, deposit flow reusing §4.3, admin review queue, status updates | Deposit dashboard tile shows real pending/completed totals |
| **4 — E-letters** | Packages, credit ledger, compose + attachments, print queue, Playwright A4 batch PDF with reply QR, scan-reply intake | A letter is composed, batch-printed, and a scanned reply lands back in the app |
| **5 — Visits** | Rounds CRUD, weekly template, materialize job, **admin week-grid schedule editor**, availability API, booking with the single-row capacity update, check-in | Staff build a month of schedule by hand; overselling is impossible under a concurrent booking test |
| **6 — News + Dashboard + Reports** | News CRUD, 4 dashboard tiles (p.11) with period selector, all 7 XLSX reports via job queue | Every report opens in Excel with correct Thai headers and matching totals |
| **7 — LINE + hardening** | LIFF wrapper, `LineIdTokenProvider`, account linking flow, Messaging API push, rich menu, SMS/LINE OTP self-service password reset, rate limiting, **PDPA retention job**, load test, restore drill, runbook | An existing password account links to LINE and receives a push; restore-from-backup rehearsed and documented |

---

## 12. Decisions — locked

| # | Decision | Consequence in this plan |
|---|---|---|
| 1 | **Multi-prison from day one** | `prison_id` on every business table; prison scope in the auth token and in middleware; department-wide records use `prison_id NULL` |
| 2 | **Manual slip verification first** | `SlipVerifier` interface ships in Phase 2 with `ManualVerifier` only; admin approval queue is the product, not a stopgap |
| 3 | **Inmate data synced from DOC** | `external_id` / `external_source` / `synced_at` / `sync_hash` on `inmates`; file-based import with dry-run diff is Phase 0b |
| 4 | **Multi-gateway: tag-30 and tag-29** | `payment_channels` table, rail per channel, amount salting for tag-29, channel recorded on every payment |
| 5 | **Single VPS, in-country** | Docker Compose + Caddy + Litestream; one API process; admin behind allowlist/VPN |
| 6 | **Admin-entered visit schedule** | `visit_rounds` + optional weekly template → materialized `visit_schedule_days` the admin edits by hand; week-grid editor is the centrepiece admin screen |
| 7 | **Username + password first** | Both realms Argon2id; phone-as-username; `AuthProvider` seam keeps LINE a Phase 7 add, not a rewrite |
| 8 | **PDPA retention agreed** | Retention job in Phase 7, windows declared in settings from Phase 0 (below) |

### PDPA retention windows (proposed defaults)

Declare these as `pdpa.retention.*` settings keys in Phase 0 even though the job doesn't run until Phase 7 — the values need departmental sign-off, and having the keys in place means adding the job later touches nothing else.

| Data | Proposed window | Reasoning |
|---|---|---|
| Letter body text + attachments | **1 year** after delivery, then purge content, keep metadata (who/when/status) | Family correspondence is the most sensitive data in the system. Metadata is enough for the p.12 letter report. |
| Slip images | **5 years** | Thai accounting/tax record-keeping expects supporting documents retained ~5 years. Don't purge financial evidence early. |
| Payment / order / deposit records | **5 years** | Same reasoning; these are financial records, not personal correspondence. |
| Visit bookings | **2 years** | Operational value drops fast; reporting only needs aggregates after year one. |
| Audit logs | **5 years** | Corrections context — you want the trail to outlast the dispute. |
| Closed customer accounts | **90 days** after deletion request, then anonymize (keep financial rows with the person detached) | Deletion requests must not blow holes in the ledger. Anonymize, don't cascade-delete. |

Purge is a **job with a dry-run mode** that reports what it would delete. Run it in dry-run for a full month before enabling it for real.

---

## 13. Remaining unknowns (don't block Phase 0)

1. **DOC export format** — column names, encoding (TIS-620 is still out there), whether zone/work-division come as codes or free text. Get one real sample file before writing the import mapper; build the mapper against the sample, not against a guess.
2. **Biller ID availability** — whether the Department already holds one, and for which account. If not, launch is tag-29-only and amount salting becomes load-bearing rather than a nicety.
3. **Rounds per day, per facility** — how many `visit_rounds` Klong Prem and Bang Kwang actually run, and their real times. Doesn't change the schema, but the admin grid layout depends on whether it's 3 rounds or 12.
4. **Order cutoff and fulfillment SLA** — `order.cutoff_time` exists as a settings key, but nobody has said what happens to an order placed at 22:00 on a Friday.
5. **Who prints the letters, and where** — one central printer per facility or one per แดน? Determines whether `letter_batches` needs a destination field.