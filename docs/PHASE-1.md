# Phase 1 — Catalog + Orders

> **Done when:** a relative can place an unpaid order end to end.

Verified against the seeded database: a relative signs in, picks a verified
inmate, browses a shop, fills a cart, places the order, and watches staff move
it `new → preparing → delivered` from the dashboard.

## What exists

### Database (`0001_phase1_catalog_orders`)

Schema §4.2, six tables:

| Table | Notes |
| --- | --- |
| `shops` | `prison_id` + nullable `zone_id` — null means the shop serves every แดน |
| `shop_hours` | optional per-shop schedule; a shop with no rows inherits the facility `shop.hours` setting |
| `categories` | department-wide, not per prison — the sales report groups by category across facilities |
| `products` | `UNIQUE(shop_id, sku)`, satang prices, optional `max_per_order` |
| `orders` | `order_no UNIQUE`, both status axes, zone/inmate snapshots |
| `order_items` | sku / name / unit / category / unit price snapshotted per line |

Indexes are the ones §5 names: `idx_orders_prison_date`, `idx_orders_paystatus`,
`idx_orders_customer`, `idx_products_shop_cat`, plus a fulfillment-queue index
the dashboard list actually filters on.

### Order numbers

`{PRISON_CODE}-{YYMM}-{SEQ}` — `KLP-2508-0001`. The sequence comes from the
`counters` table via a single insert-or-bump `UPDATE … RETURNING`, executed
inside the same `BEGIN IMMEDIATE` transaction as the order insert. Two carts
committing in the same millisecond cannot share a number, and no number is
burned when the insert rolls back.

### The server owns the price

`POST /orders` accepts product ids and quantities. Nothing else. Every line is
re-read from `products`, re-priced, and re-totalled server-side, then the
resulting name/price/unit/category are **copied onto the order line**. A price
edit an hour later leaves last month's report and the relative's receipt exactly
as they were — there is a test that proves it.

Rejections, all before a row is written:

- the relative's link to the inmate is missing or not `verified` → 403
- the inmate is not `active` → 409
- the shop is inactive, belongs to another facility, or serves a different แดน
- a product is inactive, belongs to a different shop, or exceeds `max_per_order`
- more lines than `order.max_lines` (default 50)

The same product twice in one cart merges into one line rather than erroring —
that is a UI accident, not two lines.

### Shop hours

`isOpenNow` is computed server-side in `Asia/Bangkok` and returned on every shop;
the client never guesses. Hours resolve shop rows first, then the facility
`shop.hours` setting, day by day.

**Enforcement is off by default** (`order.enforce_shop_hours`, per prison). A
fresh install and every dev machine at 22:00 can place an order; a facility turns
it on once its real hours and `order.cutoff_time` are entered. With it on, a
closed shop and a past-cutoff order both return 409.

### Fulfillment

`new → preparing → delivered`, cancel allowed from `new` or `preparing`, and
nothing moves backwards (409). Cancelling requires a reason, which the relative
sees on the order. A paid or awaiting-verify order refuses to cancel — refunds
are the Phase 2 payment spine, not a status flip here.

`delivered` and `cancelled` raise a customer notification through the Phase 0
notifier adapter (`order.ready`), so LINE push in Phase 7 is a config change at
that call site and nothing more.

Roles: catalog writes are `super_admin` + `prison_admin`; category writes are
`super_admin` only (they are shared across facilities); fulfillment adds
`zone_staff`. `finance` and `letter_operator` can read orders but not move them.

### Pagination

Products and orders both paginate by **keyset**, never offset — an opaque cursor
over `(name, id)` and `(ordered_at, id)`. A catalog edit between two page
requests cannot make a row appear twice or vanish. A malformed cursor is a 400,
not a silent page one.

### Front ends

- **Customer** — `/shop` (inmate picker + shop list with open/closed), `/shop/[id]`
  (category chips, search, paged product list, quantity steppers), `/cart`
  (review, note, place), `/orders` + `/orders/[id]` (status stepper, snapshotted
  lines, payment placeholder). The cart lives in memory only: a cart restored
  from last week would show a total the server will not honour.
- **Admin** — `/catalog` (shops, activate/deactivate), `/catalog/[shopId]`
  (products, price edit, per-shop hours editor), `/orders` (status tabs, shop
  filter, order-number/inmate search, inline advance/cancel), `/orders/[id]`.

### Settings added

| Key | Scope | Default | Why |
| --- | --- | --- | --- |
| `order.enforce_shop_hours` | prison | `false` | see above |
| `order.max_lines` | prison | `50` | cart size cap, adjustable per facility |

Both are exposed to the customer app via `/settings/public`.

## Deviations from the plan, and why

1. **`order.enforce_shop_hours` is not in `Plan.md`.** The plan has `shop_hours`
   and `order.cutoff_time` but never says whether they gate ordering. Making them
   hard gates by default would have made a fresh install unable to take an order
   outside 08:30–15:00, including every evening of development. The behaviour is
   built and tested; the switch is off until a facility opts in.
2. **`products.max_per_order`** is an extra column the plan does not list.
   Commissary caps ("ไม่เกิน 5 ห่อ") are a real rule, and enforcing them at order
   time is one integer. `0` means no cap.
3. **Customers cannot cancel their own order.** The plan's API surface has no
   such endpoint, so staff cancellation is the only path. Revisit when payments
   land and an unpaid order needs an expiry.
4. **No `POST /orders/:id/payment` yet.** That is Phase 2, together with
   `payment_channels`, QR generation and the slip pipeline. Order detail shows
   `unpaid` with a note pointing at staff.
5. **`discount_satang` is stored but always `0`.** The column is in the plan's
   schema; nothing in Phase 1 issues discounts, so the code path is a constant
   rather than a guess at a promotion model.

## Tests

`pnpm --filter @pc/api test` — 61 integration tests (33 from Phase 0, 28 new)
against a real in-memory SQLite with the real migrations. The new coverage:
server-side re-pricing, order-number format and per-facility sequencing, line
merging, the verification gate, unlinked-inmate refusal, cross-facility shop
refusal, foreign-product and over-cap refusal, empty cart and zero quantity,
own-orders-only history, cross-customer read refusal, admin scoping of both the
list and one order, the full fulfillment walk plus the backwards refusal,
cancel-needs-a-reason, role boundaries for fulfillment, snapshot immunity to a
later price edit, hours fallback and override, shop-scoped category counts,
keyset pagination without repeats, malformed cursors, duplicate SKU, duplicate
shop name, cross-prison shop creation, category writes restricted to
`super_admin`, and inactive products hidden from customers but visible to staff.

## Seed

30 products across 4 shops (2 per facility) in 5 categories, plus two orders
placed **through `placeOrder` itself** rather than inserted — the fixtures are
numbered, priced and validated exactly like real orders.

## Next: Phase 2 — Payments

`payment_channels` CRUD, tag-30 and tag-29 QR generation, amount salting,
slip upload + sharp pipeline, mini-QR decode, `trans_ref` uniqueness, and the
`ManualVerifier` approval queue. The order side is ready for it: `payment_status`
already carries `awaiting_verify`, `paid`, `failed`, `refunded` and `expired`,
and nothing in Phase 1 writes any of them.
