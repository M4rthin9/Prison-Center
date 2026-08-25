# Phase 3 — Deposits

> **Done when:** the deposit dashboard tile shows real pending/completed totals.

Verified against the seeded database: a relative registers a deposit card, a
staff member approves it and it gets a card number, the relative deposits money,
uploads a slip, finance verifies it, and the deposit sits in `กำลังตรวจสอบ`
until a staff member confirms the money went into the inmate's account. The
tile numbers are computed from `deposits`, not stored anywhere.

## What exists

### Database (`0004_phase3_deposits`)

Schema §4.4, two tables.

`deposit_cards` — `ลงทะเบียนทำบัตรฝากเงิน` (p.13) is a one-time approval per
`(customer, inmate)`, and the pair is UNIQUE: a rejected or suspended card is
reopened on that same row rather than duplicated. `card_no`
(`{PRISON_CODE}-C{YYMM}-{SEQ}`) is allocated on the **first** approval and kept
for good — a suspended card that comes back is the same card.

`deposits` — `deposit_no` is `{PRISON_CODE}-D{YYMM}-{SEQ}` from the same
insert-or-bump `counters` row as orders and payments, allocated inside the
insert transaction. `zone_id` / `zone_name_snapshot` / `inmate_*_snapshot` are
stored, never joined live, so a zone transfer cannot rewrite last month's
deposit report (§4.1). `depositor_name` is its own column because the money is
not always from the account holder (p.7).

Indexes: `uq_deposits_deposit_no`, `idx_deposits_review`
(`prison_id, status, deposited_at` — exactly what the queue reads),
`idx_deposits_customer`, `idx_deposits_inmate`, `idx_deposits_payment`.

### The payment spine did not change

`purpose='deposit'` was already in the Phase 2 enum and in the seeded channels'
`supports_purposes_json`. What Phase 3 added is the refactor that makes that
true in code: `createOrderPayment` was split into a generic
**`createPaymentFor(spec)`** — purpose, purpose id, customer, prison, amount,
inmate code, channel — with the order flow as a thin wrapper. A deposit differs
from an order in exactly one thing: where the amount is read from.

Everything else comes along for free: the salted charge, the one-live-payment
rule (asking twice while the QR is alive returns the same QR, it does not burn
a second salt), rail switching retiring the old QR, TTL expiry, the
`trans_ref` uniqueness, the slip pipeline, and the manual verify queue.

The dependency runs one way. `modules/deposits/status.ts` holds the deposit's
half of a payment event and imports nothing back from `modules/payments`, so
the spine stays ignorant of what it is paying for.

### Two statuses, because there are two events

p.7 shows `อัปเดตสถานะ → กำลังตรวจสอบ → เสร็จสิ้น`, and the reason there are
two is that money arriving at the facility and money reaching the inmate's
account are different events, hours or days apart.

| Deposit | Meaning | Set by |
| --- | --- | --- |
| `pending` | waiting for the relative's transfer, or for their slip to pass | creation; also a rejected slip |
| `reviewing` | slip verified — the money is at the facility (`deposited_at`) | the Phase 2 payment verify |
| `completed` | credited to the inmate's account inside the prison (`completed_at`) | the deposit review queue |
| `rejected` | closed, with a reason; also where a refunded payment lands | staff |
| `cancelled` | the relative abandoned it while still unpaid | the relative |

`completed` is refused while `deposited_at` is null — a deposit cannot be
credited before the money has been shown to exist. Transitions are a table, not
a set of ifs: `pending → rejected`, `reviewing → completed | rejected`, and the
three terminal states go nowhere.

### The two gates

1. **The verified relative link** (§4.1b) — the same gate orders use. No card,
   no deposit, no anything against an unverified link.
2. **The deposit card**, per prison via `deposit.require_card` (default on),
   because registering the card is a real counter step at the facility.

Plus three prison-scoped settings that keep a facility in control of the
amounts: `deposit.min_satang` (default ฿100), `deposit.max_satang` (default
฿20,000) and `deposit.max_open_per_inmate` (default 3). The first two, and
`deposit.require_card`, are exposed to the customer app so the deposit form can
state the rules up front.

### Endpoints

Customer:

```
GET/POST /deposit-cards                   ลงทะเบียนทำบัตรฝากเงิน
POST     /deposits                        creates the deposit *and* its QR
POST     /deposits/{id}/payment           a fresh QR for the same deposit
GET      /deposits?cursor&status
GET      /deposits/{id}
POST     /deposits/{id}/cancel            pending only, and not with a slip pending
POST     /payments/{id}/slip              unchanged from Phase 2
```

`POST /deposits/{id}/payment` exists so that an expired QR or a change of
channel does not become a second deposit: the number and the amount stay, only
the payment is renewed.

Admin:

```
GET  /admin/deposits?status&q&from&to&cursor
GET  /admin/deposits/summary?from&to      the p.11 tile
GET  /admin/deposits/{id}
POST /admin/deposits/{id}/review          reviewing | completed | rejected
GET  /admin/deposit-cards?status
POST /admin/deposit-cards/{id}/review     approved | rejected | suspended
```

Reviewing is `super_admin`, `prison_admin` and `finance` — the same three roles
that verify payments. `zone_staff` may read the queue and nothing more. Every
query is scoped through `prisonScope` / `resolvePrisonId` / `assertInScope`.

### The dashboard tile

`GET /admin/deposits/summary` groups `deposits` by status over a period and
returns per-status counts and totals plus two derived numbers:
**`receivedSatang`** (`reviewing + completed` — money whose slip has passed,
credited or not, which is what reconciles against `payments`) and
**`completedSatang`**. Nothing is precomputed; the tile is a query.

### Customer UI (LIFF)

`/deposits` — card registration per verified inmate with its approval state,
the deposit form (inmate, amount, depositor name) showing the facility's
minimum and maximum, and the history list.

`/deposits/{id}` — the deposit, its status in plain Thai, and the pay panel.

The pay-by-slip experience is now one component, `lib/PaymentPanel.svelte`
(channel picker, QR, exact-satang amount with copy button, live TTL countdown,
Ref1/Ref2, slip upload), shared by the order pay screen and the deposit screen.
The spine is one thing server-side; it is one thing in the app too.

### Admin UI

`/deposits` — four tiles, the pending card queue inline, status tabs
(`รอโอนเข้าบัญชี` first, because that is the work), search over deposit number,
inmate and depositor, and a detail drawer with the slip link and the
**โอนเข้าบัญชีแล้ว** button. The drawer says out loud that slip checking lives
on the payments screen and this screen is the crediting step.

## Decisions worth knowing

1. **Slip verification stays in the payments queue.** Two queues for one slip
   would mean two people looking at the same image. The deposit queue starts
   where the payment queue ends.
2. **A rejected slip returns the deposit to `pending`, not `rejected`.** The
   relative can try again with a better photo; the failed payment row keeps the
   record of why the first attempt died.
3. **A refund closes the deposit as `rejected`.** Money that went back out is
   not a deposit, and the row is never deleted — the ledger keeps its shape.
4. **Cancellation is refused once a slip is uploaded.** At that point staff are
   holding evidence; the answer is reject-with-reason, not a silent unwind.
5. **`depositNo` joined `orderNo` on the payment views** rather than becoming a
   generic `purposeNo`. Additive, so nothing in Phase 1/2 had to change, and the
   admin payment list now names either kind of thing.

## Tests

`pnpm --filter @pc/api test` — 136 integration tests (114 from Phases 0–2 and 0b,
22 new) against a real in-memory SQLite with the real migrations and an
in-memory storage adapter, with slips synthesised by `sharp`.

The new coverage: a card requested and approved with a `BKW-C…` number, a card
refused for an unverified link, a duplicate request refused, a suspended card
keeping its number when reinstated, the card queue scoped per facility, a
deposit created with a salted QR and a snapshotted zone, the missing-card
refusal, the minimum and maximum, the full `pending → reviewing → completed`
walk, `completed` refused before the slip is verified, a rejected slip returning
the deposit to `pending`, a refund closing it as `rejected`, a fresh QR for the
same deposit number, cancellation killing the QR and being refused twice,
cancellation refused while a slip waits, the per-inmate open cap, a relative
seeing only their own deposits, the scoped review queue, `zone_staff` refused,
search by number and by inmate name, the dashboard totals matching the list
row-for-row, and deposit payments never carrying an order number.

## Seed

An approved deposit card and one open ฿1,000 deposit at คลองเปรม, plus a second
card request left pending so the review queue is not empty on a fresh install —
all created through the real services, so the fixtures are numbered, gated and
priced exactly like real ones.

## Next: Phase 4 — E-letters

`letter_packages`, the credit ledger, compose + attachments, the print queue,
Playwright A4 batch PDF with a reply QR, and scan-reply intake. The letter
package purchase is the third `purpose` on the payment spine, and it needs
nothing new from it.
