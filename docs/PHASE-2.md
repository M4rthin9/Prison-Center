# Phase 2 — Payments

> **Done when:** both rails settle an order manually; a duplicate slip and a
> wrong-amount slip are both rejected.

Verified against the seeded database: a relative picks a rail, gets a QR with a
salted amount, uploads a photo of a slip, and staff settle or reject it from the
payment queue. The same slip cannot be used twice, and a slip one satang short
is refused.

## What exists

### Database (`0002_phase2_payments`)

Schema §4.3, two tables.

`payment_channels` — the rail is configuration, not code (decision #4). A
facility may run several at once, and `prison_id NULL` is a department-wide
channel every facility can use.

| Rail | Carries | Reconciled by |
| --- | --- | --- |
| `promptpay_bill_payment` (tag-30) | Biller ID + Ref1/Ref2 | Ref1 = `payment_no`, exact |
| `promptpay_credit_transfer` (tag-29) | nothing | the salted amount + `trans_ref` |
| `bank_transfer` | nothing — account shown as text | the salted amount + `trans_ref` |

`payments` — one spine for every purpose. `purpose` + `purpose_id` point at the
order (and later the deposit, and the letter package); nothing else in the row
knows which. `charge_satang = amount_satang + amount_salt_satang`, and it is the
charge that goes in the QR and gets matched against the slip. The order total
stays clean for reports.

Indexes: `uq_payments_payment_no`, `uq_payments_trans_ref`,
`idx_payments_purpose`, `idx_payments_status`, `idx_payments_prison_created`,
`idx_payments_customer`, `idx_payments_channel_live` (exactly what the salt
allocator scans) and `idx_payments_expiry`.

### `trans_ref` is UNIQUE, system-wide

One slip settles exactly one payment. That single constraint is the entire
anti-fraud mechanism, and it is enforced twice over: the reference decoded from
the mini-QR is claimed at **upload** time, so a duplicate slip cannot even enter
the review queue, and the reference a reviewer types is claimed again at
**verify** time. Both paths turn the UNIQUE violation into a Thai sentence
rather than a 500.

### Payment numbers

`{PRISON_CODE}-P{YYMM}-{SEQ}` — `KLP-P2508-0001`, from the same
insert-or-bump `counters` row as order numbers, inside the payment's own
transaction. The `P` keeps a payment number from being mistaken for an order
number in a bank statement export, and the dash-stripped form (`KLPP25080001`)
is what goes into the tag-30 Ref1 field.

### QR generation

`lib/payments/emvco.ts` is TLV plus CRC-16/CCITT-FALSE and nothing else;
`promptpay.ts` builds both rails on top of it. No QR library is involved in
constructing the payload — the only dependency is `qrcode`, and only to raster
the finished string.

- **tag-29**: mobile proxies travel as `0066` + the number without its leading
  zero, national IDs as 13 digits, e-wallets as 15. The amount field is always
  two decimals: a relative who transfers ฿470.40 against a ฿470.37 charge has
  not paid.
- **tag-30**: Biller ID is 15 digits (13-digit tax id + bank-issued 2-digit
  suffix, accepted as one field or two). Ref1/Ref2 are configurable per channel
  — `payment_no`, `inmate_code` or `customer_phone` — and are normalised to
  uppercase alphanumeric because banks mangle anything else.

The API renders the QR image and returns a data URL. A front end that builds its
own payload is a front end that can get the amount wrong.

### Amount salting

`amount_salt_enabled` allocates 1–99 satang inside the payment's `BEGIN
IMMEDIATE` transaction. The invariant enforced is slightly stronger than the
plan's: the **charged amount** must be unique among the channel's live
(`pending` + `awaiting_verify`) payments, not merely the salt. Two different
order totals may safely share a salt, which is what keeps a busy channel from
exhausting 99 values. The salt is chosen from a random start rather than
sequentially — a predictable satang tail leaks how many payments a facility has
taken today. It returns to the pool when the payment settles or expires.

Salting is forced off on tag-30: Ref1 already carries an exact key.

### The slip pipeline

`sharp` decodes, applies the EXIF orientation, resizes to 1600px and re-encodes
to JPEG. The re-encode is the point — it is what discards the EXIF block, and a
slip photo's EXIF carries the GPS coordinates of the relative's house.

The mini-QR is then read with `jsQR` across five attempts that trade area for
resolution (whole image, 2×, bottom half, bottom-right, bottom-left), because
the code is physically tiny and a downscaled phone photo rarely decodes on the
first try. Grayscale + normalise runs first for contrast, then the single-channel
buffer is widened to RGBA because jsQR reads nothing else.

A slip with no readable code is accepted anyway; staff type the reference in.

### Verification

`SlipVerifier` ships with one implementation, `ManualVerifier` (decision #2). It
is handed what a human read off the slip and applies §4.3's rules:

1. `trans_ref` is present, long enough, and not already spent.
2. The amount is compared for **exact integer satang equality**. No tolerance
   window — a tolerance is an invitation to pay ฿1 less than the salted amount.
3. `transferred_at` falls between the payment's creation and its expiry plus
   `payment.slip.grace_minutes`.
4. Optionally, the receiving bank and last-4 of the account match the channel.

Failures come back as a 409 whose message is the list of reasons, in Thai, ready
to be shown to the reviewer.

Adding an aggregator later is a second implementation of this interface plus a
settings key. `verifierFor()` is the seam.

### Status flow

```
payments:  pending ──slip──▶ awaiting_verify ──verify──▶ succeeded ──▶ refunded
              │                     │
           expire                 reject
              ▼                     ▼
           expired                failed

orders:    unpaid ──slip──▶ awaiting_verify ──verify──▶ paid ──refund──▶ refunded
              ▲                     │
              └──────── reject ─────┘
```

A rejected payment sends the order back to **`unpaid`**, not `failed`: the
relative can pay again, and the failed payment row keeps the record of why the
first attempt died. Only `pending` payments expire — one with a slip on it is
waiting on staff, and expiring it would discard evidence.

Asking for a QR again while one is still alive returns the same QR. A relative
who refreshes the pay screen has not started a second payment; picking a
different channel does retire the old one first, so its salt goes back.

### Refunds, and order cancellation

`POST /admin/payments/:id/refund` records a refund as a state — the money moves
through whatever channel finance actually uses. It exists because Phase 1's
cancel path hard-blocked any order with money on it. Now: an order awaiting
verification must have its slip decided first, a paid order must be refunded
first, and cancelling an order kills any live QR behind it.

### API

```
GET    /payment-channels?prisonId&purpose      no biller id, no proxy value
POST   /orders/:id/payment      { channelId? } → QR, charge, expiry, payment_no
GET    /payments?cursor  /payments/:id
POST   /payments/:id/slip       multipart
GET    /payments/:id/slip       the image, behind the session

GET    /admin/payment-channels  POST  PATCH /:id
GET    /admin/payments?status&rail&purpose&channelId&q&from&to&cursor
GET    /admin/payments/:id      GET /admin/payments/:id/slip
POST   /admin/payments/:id/verify | /reject | /refund
```

Slips are served through the API rather than from a public storage URL: an
unguessable key is not an access control, and a slip is a financial document
about a named person.

Roles: channel writes are `super_admin` + `prison_admin` (department-wide
channels, `super_admin` only). Verify / reject / refund is `finance` plus both
admins. `zone_staff` and `letter_operator` can do neither.

### Settings added

| Key | Scope | Default | Why |
| --- | --- | --- | --- |
| `payment.slip.grace_minutes` | prison | `120` | a relative who transferred at 23:58 against a 30-minute QR has still paid |
| `payment.slip.require_bank_match` | prison | `false` | the receiving bank on a slip photo is free text; a facility with one account per แดน would trip over it constantly |

`payment.qr.ttl_minutes`, `payment.salt.enabled` and `payment.channel_default`
were already declared in Phase 0 and are now load-bearing.

### Front ends

- **Customer** — `/orders/[id]/pay`: channel picker, QR with a live countdown,
  the exact charge with a copy button and an explicit warning about the satang
  tail, Ref1/Ref2 when the rail has them, slip upload, and the rejection reason
  when there is one. Order detail links straight into it.
- **Admin** — `/payments` (the p.9 list, status tabs, a review drawer with the
  slip beside the expected numbers and a live mismatch warning on the amount
  field) and `/payment-channels` (per-rail CRUD that only shows the fields the
  chosen rail actually uses).

## Deviations from the plan, and why

1. **Charge uniqueness rather than salt uniqueness.** The plan says the salt is
   unique among pending payments on a channel; the code makes `charge_satang`
   unique instead. It is the stronger property, it is the one reconciliation
   actually needs, and it does not cap a channel at 99 concurrent payments.
2. **`trans_ref` is claimed at upload, not only at verify.** The plan only
   requires uniqueness. Claiming early means a duplicate slip is refused at the
   phone rather than after a staff member has looked at it.
3. **The slip mini-QR layout is inferred, not specified.** Thai slip mini-QRs
   are EMVCo-shaped TLV with a `91` CRC — tag `01` sending bank, tag `02`
   reference. That is what `parseSlipMiniQr` reads. It has not been tested
   against a real slip from every bank, and it does not need to be: the payload
   is unsigned plaintext (§4.3 rule 2), so a wrong parse costs a staff member
   twenty keystrokes and nothing else. **Get a real slip from each major bank
   before launch** and widen the parser if any of them differ.
4. **A refund endpoint, which Phase 2's scope does not list.** `refunded` is in
   the schema's status enum and Phase 1 left order cancellation blocked behind
   it. It is a status write and a notification, not a transfer.
5. **`bank_transfer` is a first-class rail.** The plan lists it in the enum but
   describes only the two PromptPay rails. It costs nothing — no QR, the account
   number on screen is the instruction — and it is what a facility whose
   vocational shop has no PromptPay registration will actually use.
6. **The seeded tag-30 channel is inactive.** It is department-wide with an
   obviously fake Biller ID, switched off until a real one exists (§13
   unknown #2). tag-29 is what works on a fresh install.

## Tests

`pnpm --filter @pc/api test` — 91 integration tests (61 from Phase 1, 30 new)
against a real in-memory SQLite with the real migrations, with an in-memory
storage adapter so no slip touches the disk. Slips are synthesised with `sharp`:
a white page with a real mini-QR composited near the bottom, then pushed through
the actual upload endpoint.

The new coverage: the CRC check value, both payloads' structure and two-decimal
amount, mini-QR round trip and refusal to invent a reference from noise, the
public channel list leaking neither Biller ID nor proxy, per-rail channel
validation, a prison admin's channel being pinned to their own facility, salting
range and QR rendering, the same QR returned on reload, two identical totals
getting two different charges, rail switching retiring the old QR, refusing to
bill someone else's order, EXIF-stripped storage and the authenticated slip
route, the duplicate slip at upload, a non-image upload, an unreadable slip
still being accepted, settlement to the satang, the one-satang-short rejection,
the transfer-too-late rejection, a spent reference refused at verify, a rejected
slip returning the order to unpaid and being retryable, `finance` allowed and
`zone_staff` refused, cross-facility refusal, the full tag-30 walk including
Ref1/Ref2, expiry leaving `awaiting_verify` alone, cancellation killing a live
QR, and the scoped payment list.

## Seed

4 payment channels: a tag-29 mobile proxy at คลองเปรม, a tag-29 national-ID
proxy at บางขวาง, a bank transfer account at คลองเปรม, and the inactive
department-wide tag-30 channel.

## Next: Phase 3 — Deposits

`deposit_cards`, the deposit flow reusing this exact spine (`purpose='deposit'`
is already in `supports_purposes_json` on the seeded channels), and the admin
review queue. Nothing in the payment code needs to change for it: the only
thing `createOrderPayment` knows that a deposit would not is where to read the
amount from.
