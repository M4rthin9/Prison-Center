# Phase 4 — E-letters (Domimail)

> **Done when:** a letter is composed, batch-printed, and a scanned reply lands
> back in the app.

Verified against the seeded database: a relative buys a coupon book, staff pass
the slip, the coupons appear as a ledger movement, the relative writes a letter
that spends one of them, a letter operator makes a print batch, the A4 document
comes out of the job queue with a reply QR on every sheet, and a scan of that
sheet comes back in and shows up in the family's app as a `to_home` letter tied
to the letter it answers.

## What exists

### Database (`0005_phase4_letters`)

Schema §4.5, six tables.

`letter_packages` — `prison_id NULL` means department-wide, exactly like a
payment channel, so a fresh install offers the p.12 shapes (฿100 → 10 ฉบับ,
both directions) everywhere without per-facility setup.

`letter_purchases` — a purchase row exists **before** the money does, because
the payment spine needs something to point `purpose_id` at. Name, price, quota
and direction are snapshotted: repricing a package next month must not rewrite
what somebody bought this month.

`letter_credit_ledger` — the decision §4.5 insists on. Balance is
`SELECT balance_after … ORDER BY created_at DESC LIMIT 1` for a
`(customer, direction)` pair, appended inside the same transaction as the thing
that spends it. There is no `credits_remaining` column anywhere, because that
column drifts the first time a print job dies halfway.

`letters` — `letter_no` (`{PRISON_CODE}-L{YYMM}-{SEQ}`) is allocated at **draft**
time, not at submit: it is printed on the sheet and encoded in the reply QR, so
it has to exist before there is anything to print. `zone_id`,
`zone_name_snapshot` and the inmate/customer name snapshots follow the §4.1 rule
— a transfer mid-month must not re-file last month's letters.

`letter_batches` — one batch is one stack of paper for one แดน. `format` records
whether a real browser drew the PDF or the HTML fallback did.

`letter_attachments` — photos, EXIF-stripped by the same sharp pipeline the
slips use.

Indexes: `uq_letters_letter_no`, `idx_letters_print_queue`
(`prison_id, zone_id, status, created_at` — exactly what the queue reads),
`idx_credit_ledger_latest` (`customer_id, direction, created_at DESC` — exactly
what the balance read is), plus the sender/recipient/batch/reply lookups.

### Credits are a ledger

`modules/letters/credits.ts` is its own module, and that is not tidiness. The
payment spine calls into `letters/status.ts` to grant coupons; the letter
service calls into the payment spine to make a QR. Putting `moveCredits` in the
service would close that loop into an import cycle. Credits, which need nothing
but the database, sit underneath both.

Every movement carries `reason` (`purchase | consume | refund | admin_adjust |
expiry`) and a `ref_type`/`ref_id` pointing at the letter or purchase that
caused it. Two invariants come out of that pairing:

- **A quota is never granted twice.** `onLetterPurchasePaymentVerified` returns
  early if the purchase is already `paid`, so a double-verify is a no-op.
- **A coupon is never refunded twice.** `refundLetterCredit` looks for the
  matching `consume` row and for an existing `refund` row against the same
  letter before it appends anything.

A refund on a purchase whose coupons have already been spent drives the balance
negative. That is deliberate: the ledger records what happened, it does not
pretend the letters were never sent.

### The payment spine took a third purpose and needed nothing new

`purpose='letter_package'` was already in the Phase 2 enum and in the seeded
channels' `supports_purposes_json`. Buying a package calls the same
`createPaymentFor(spec)` a deposit does; the only difference is that a coupon
book has no inmate, so `inmateCode` is null and a tag-30 channel configured for
`ref2_mode='inmate_code'` simply omits it.

`letters/status.ts` holds the purchase's half of a payment event and imports
nothing from `modules/payments`, the same one-way arrangement Phase 3 set up.
`letterPurchaseNo` joined `orderNo` and `depositNo` on the payment views —
additive, so nothing in Phases 1–3 had to change.

### Statuses, because there are that many real events

| Letter | Meaning | Set by |
| --- | --- | --- |
| `draft` | being written; costs nothing | compose |
| `queued` | submitted, one coupon spent | the relative |
| `pending_print` | pinned to a batch | making a batch |
| `printed` | ink on paper | the batch, or one letter |
| `dispatched` | handed to the แดน | staff |
| `delivered` | in the inmate's hands | staff — or a scanned reply, which proves it |
| `rejected` | refused, or cancelled by the sender; coupon refunded | either |

Transitions are a table, not a set of ifs. `delivered` and `rejected` go
nowhere.

A `to_home` letter uses `queued` for one extra thing: a scanned reply the family
has not paid for yet. See below.

### The print pipeline

`POST /admin/letters/batches` does two things in one immediate transaction:
allocate `batch_no` and flip every matching `queued` letter to `pending_print`
with `batch_id` set. Pinning **before** drawing is what makes it impossible for
two operators to print the same letter twice. Only then does it enqueue
`letter.batch_pdf`.

The job builds one HTML document — a cover sheet listing every letter for the
walk, then one A4 page per letter — and hands it to a `LetterRenderer`:

- **`playwright`** launches Chromium and prints the PDF. Thai glyph clusters are
  shaped by the browser's text engine, which is the whole reason §2 chose
  Playwright over pdfkit.
- **`html`** stores the same document as HTML for the operator to print from a
  browser (Ctrl-P → A4). The `@page` rule is identical, so the layout is.

`LETTER_RENDERER=auto` (the default) tries Playwright and falls back with a
warning recorded on the batch row rather than failing. Playwright is **not** a
dependency of `@pc/api`: it is a ~300 MB browser download that a dev machine and
CI have no use for. On the box that actually prints:

```
pnpm --filter @pc/api add playwright
pnpm --filter @pc/api exec playwright install chromium
```

and the renderer starts producing PDFs with no code change.

### The reply QR is the design, not a decoration

Every printed sheet carries `PCL:{letter_no}` as a QR in the header, and a
dashed `แบบฟอร์มตอบกลับ` box below the body with ruled lines for the reply. The
page says out loud not to cut or cover the QR, because that QR is the only thing
that gets a handwritten answer back to the right family.

`POST /admin/letters/scan-reply` takes the scan, normalises it (2200px, EXIF
stripped), and reads the QR with the same multi-attempt decoder the slip
pipeline uses — with attempts aimed at a flatbed page rather than a phone photo
of a receipt. The scan wins over a hand-typed `letterNo`, because a typed number
is the thing most likely to be wrong.

The reply becomes a new `letters` row: `direction='to_home'`,
`reply_to_letter_id` set, the scan stored as its body. And the outgoing letter
is marked `delivered` — the inmate wrote on it, which is better proof than a
staff member clicking a button.

### The paywall on replies, and how it stays humane

p.12 prices both directions, so a scanned reply consumes one `to_home` coupon.
When the family has none, three things happen in that order, and the order is
the point:

1. **The scan is stored anyway.** The paper passes the scanner once. Refusing
   the intake would destroy family correspondence to enforce a ฿10 charge.
2. The reply lands as `queued` and its `/scan` endpoint returns 403.
3. `releaseHeldReplies` runs the moment a `to_home` purchase is verified and
   unlocks held replies oldest-first, one coupon each.

`letter.reply_consumes_credit` (per prison, default on) turns the whole thing
off for a facility that decides replies should be free.

### Endpoints

Customer:

```
GET  /letter-packages?prisonId&direction
POST /letter-packages/{id}/purchase        creates the purchase *and* its QR
GET  /letter-purchases?cursor              ประวัติการเติมสิทธิ์ (p.4)
GET  /letter-purchases/{id}
POST /letter-purchases/{id}/payment        a fresh QR, never a second purchase
POST /payments/{id}/slip                   unchanged from Phase 2

GET  /letters/credits                      balance + last 30 ledger movements
GET  /letters?direction&status&cursor
POST /letters                              a draft — costs nothing
PATCH/POST /letters/{id}                   edit / attach / detach, drafts only
POST /letters/{id}/submit                  spends one coupon
POST /letters/{id}/cancel                  refunds it, until the batch pins it
GET  /letters/{id}/attachments/{attId}
GET  /letters/{id}/scan                    403 while a reply is unpaid
```

Admin:

```
GET  /admin/letters?status&zoneId&direction&batchId&q&from&to&cursor
GET  /admin/letters/summary?from&to
GET  /admin/letters/{id}   ·   GET /admin/letters/{id}/scan
POST /admin/letters/{id}/status            printed | dispatched | delivered | rejected
GET  /admin/letters/batches   ·   POST /admin/letters/batches
GET  /admin/letters/batches/{id}   ·   /file   ·   POST /{id}/printed
POST /admin/letters/scan-reply             multipart, QR-decoded
GET/POST/PATCH /admin/letter-packages
```

`letter_operator` is finally a role that does something: it can make batches,
mark them printed, move a letter's status and run the scan intake — everything
except pricing, which stays with `prison_admin` and `super_admin`. `zone_staff`
reads the queue and nothing more. Every query goes through `prisonScope` /
`resolvePrisonId` / `assertInScope`.

Attachments, scans and batch files are all served **through the API** with a
session, never from a public path. A family photo, a handwritten reply and a
stack of correspondence are the most sensitive data in this system.

### Settings

| Key | Scope | Default | Why |
| --- | --- | --- | --- |
| `letter.max_chars` | prison | 3000 | what one A4 sheet holds, not an arbitrary product cap |
| `letter.max_attachments` | prison | 3 | photos print on the same sheet |
| `letter.batch_max` | prison | 50 | one walk to one แดน |
| `letter.reply_consumes_credit` | prison | true | the p.12 prepaid model, switchable |

`letter.max_chars` and `letter.max_attachments` are exposed to the customer app
so the compose screen can state the limit while you type rather than after you
press send. `letter.packages` (declared back in Phase 0) is now what the seed
reads to fill the table — the table is the source of truth afterwards, because
staff edit packages and nobody edits a settings key.

### Customer UI (LIFF)

`/letters` — direction tabs, the balance read straight from the ledger, the
package shelf, and the letter list. A `to_home` letter that is still held shows
`รอเปิดอ่าน` rather than a status nobody outside the codebase understands.

`/letters/compose` — recipient, body with a live character count against the
facility's limit, photos, and one button that says what it costs:
**ส่งเข้าคิวพิมพ์ (ใช้สิทธิ์ 1 ฉบับ)**. The draft is created lazily on the first
photo or on submit, so opening the screen and backing out leaves nothing behind.

`/letters/{id}` — the letter, its attachments, the scanned reply if there is
one, and the cancel button while cancelling is still possible.

`/letters/purchases` and `/letters/purchases/{id}` — the top-up history from
p.4, the ledger movements behind the balance, and the pay screen, which is the
same `lib/PaymentPanel.svelte` orders and deposits use.

### Admin UI

`/letters` — four tiles, the batch table with **สร้างรอบพิมพ์ (n)** showing how
many letters are waiting, an open-file link, and **พิมพ์แล้ว**; the scan-reply
drop zone with a manual letter-number field for a smudged QR; then the queue
with status tabs, search, and a detail drawer carrying the body, the scan and
the status actions.

## Decisions worth knowing

1. **`letter_no` is allocated at draft, not at submit.** It is printed and
   encoded; it cannot be assigned later. Drafts that are never sent burn a
   number, which is cheap and beats a number that appears halfway through a job.
2. **A draft costs nothing; `submit` costs one coupon.** Two endpoints instead
   of one, so that attaching photos (which needs a letter id) does not force a
   charge on someone who is still deciding what to write.
3. **Cancel is refused once the letter is in a batch.** After that the sheet may
   already be on a printer; the answer is reject-with-reason, not a silent
   unwind.
4. **A staff rejection before delivery refunds the coupon.** The family paid to
   send a letter, not to have one refused.
5. **A scanned reply marks the outgoing letter `delivered`.** The inmate wrote
   on it. That is stronger evidence than any button.
6. **A held reply is stored, not refused.** See above — the paper passes once.
7. **Playwright is optional and lazily imported.** A letter queue must not stall
   because a browser binary is missing, and CI must not download 300 MB to run
   an integration test.

## Tests

`pnpm --filter @pc/api test` — 159 integration tests (136 from Phases 0–3, 23
new) against a real in-memory SQLite with the real migrations, an in-memory
storage adapter, and the HTML renderer pinned so no browser is needed.

The new coverage: both department-wide packages offered; a purchase producing a
`KLP-M…` number and a QR while granting nothing; a verified slip granting the
quota with the ledger row to match; a double-verify granting nothing extra; an
unverified relative refused; a draft costing nothing and a submit costing one;
submit refused with a zero balance; an empty letter refused; the attachment cap,
attachment retrieval and attachments refused after submit; cancel refunding the
coupon; one relative refused another's letter; a batch pinning its letters
before the job runs, the job producing a document containing the letter number,
the reply form and an embedded QR, and the batch marking every letter printed;
an empty queue refusing a batch; `zone_staff` refused a batch but allowed the
queue; cross-prison scoping on both list and detail; a staff rejection refunding
the coupon; a rejection with no reason refused and a status skip refused; the
full scan-reply walk with the QR read off a synthesised A4 sheet; a reply held
and then released by a later purchase with the scan sealed in between; a
duplicate scan refused; an unreadable QR reported and the typed fallback
working; and an unknown letter number reported rather than thrown.

## Seed

Two department-wide packages, one paid coupon book for `0812345678` (through
the real purchase flow and the real grant event, not hand-written ledger rows),
and one letter already sitting in the print queue so the batch button does
something on a fresh install.

## Next: Phase 5 — Visits

`visit_rounds` CRUD, the weekly template, the materialize job, the admin
week-grid schedule editor, the availability API, booking with the single-row
capacity update, and check-in. Decision #6 says staff enter the schedule by
hand, so the week grid is the centrepiece screen, not a fallback.
