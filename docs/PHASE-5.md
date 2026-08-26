# Phase 5 — Visits

> **Done when:** staff build a month of schedule by hand; overselling is
> impossible under a concurrent booking test.

Verified against the seeded database: a prison admin defines rounds, fills in
the weekly template, presses one button to materialize four weeks of calendar,
then edits individual cells by hand — capacity, แดน, closed for a holiday — and
those edits survive every subsequent run of the job. A relative sees only the
slots that belong to their inmate's แดน, books one, and the seat is taken by a
single-row `UPDATE` that cannot oversell. Ten concurrent bookings against a
three-seat cell produce exactly three bookings.

## What exists

### Database (`0006_phase5_visits`)

Schema §4.6, four tables.

`visit_rounds` — รอบเยี่ยม, per facility, because the count genuinely differs
between Klong Prem and a provincial prison. `start_time`/`end_time` are `HH:MM`
Bangkok wall clock, never timestamps: a round is a time of day.
`UNIQUE(prison_id, round_no)`.

`visit_schedule_templates` — the p.12 grid as a *starting point*. One row per
(weekday, round, zone) with a capacity. Nothing reads it at request time.

`visit_schedule_days` — **the model**. One row = one bookable cell, with its own
capacity and its own counter, keyed `UNIQUE(prison_id, date, round_id, zone_id)`
and guarded by `CHECK(booked_count >= 0 AND booked_count <= capacity)`.
`source ∈ template | manual`.

`visit_bookings` — `booking_no` (`{PRISON_CODE}-V{YYMM}-{SEQ}`), the round and
แดน snapshotted per §4.1 so a transfer mid-month cannot re-file last month's
visits, plus `starts_at` as epoch ms so the cutoff and the reminder compare
numbers rather than strings.

Indexes: `uq_visit_days_cell`, `idx_visit_days_grid`
(`prison_id, date, round_id` — what the week grid reads), `idx_visit_days_zone`
(`prison_id, zone_id, date` — what availability reads), `idx_visit_bookings_gate`
(`prison_id, visit_date, status` — the gate list), and
`idx_visit_bookings_reminder`.

### One deviation from §4.6, on purpose

§4.6 writes `UNIQUE(inmate_id, visit_date)`. Taken literally, a cancelled
booking would permanently block that inmate's day — a family that cancels on
Monday could never rebook Thursday's slot. The index shipped is **partial**:

```sql
CREATE UNIQUE INDEX uq_visit_bookings_inmate_day
  ON visit_bookings (inmate_id, visit_date)
  WHERE status in ('pending','confirmed','checked_in');
```

Same guarantee — one *live* visit per inmate per day — without the trap. The
service also checks it first so the error is readable Thai rather than a
constraint name; the index is what makes it true under a race.

### Booking is the §4.6 transaction, verbatim

```sql
BEGIN IMMEDIATE;
UPDATE visit_schedule_days
   SET booked_count = booked_count + 1
 WHERE id = ? AND is_closed = 0 AND booked_count < capacity;
-- 0 rows changed → slot full or closed, roll back
INSERT INTO visit_bookings (...);
COMMIT;
```

The guard lives **in the WHERE clause**, so there is no read-then-write window
at all. `BEGIN IMMEDIATE` takes the write lock before the statement, which is
the same reason the job queue is safe on SQLite. `CHECK` is the backstop.

Cancellation decrements in the same transaction as the status change, with
`max(0, …)` so a counter that somehow drifted cannot take a cancellation down
with a constraint violation.

**A no-show does not give the seat back.** The round has passed; the seat was
held and never used. That is an attendance fact, not a cancellation, and the
p.12 report needs to tell the two apart.

### Materialize: manual edits win, permanently

The job inserts one row per (date, round, zone) that the template says should
exist, with `ON CONFLICT DO NOTHING` on the natural key. That single clause is
the whole "manual edits win" mechanism: a row that exists — because it was
generated last week, or because a staff member typed it — is never touched
again. And any staff edit flips `source` to `manual`, so the grid can show which
cells a person has been at.

Running it twice creates nothing. It runs hourly from the scheduler's
housekeeping tick, and on demand from the admin's **สร้างตารางล่วงหน้าจากแม่แบบ**
button. Pressing that button repeatedly is always safe, which is exactly the
property you want on a screen people use daily.

Deleting a generated cell would just bring it back on the next run, so the API
refuses to delete a cell with bookings and the UI offers **ปิดช่องนี้** instead —
closing is a state the calendar remembers; deletion is not.

### Availability is filtered by the inmate's แดน

A visit happens in the inmate's zone, so `GET /visits/availability` reads
`visit_schedule_days` for `(prison_id, zone_id)` and nothing else — never the
template, never a weekday rule evaluated at request time. An inmate with no แดน
on file gets an empty list rather than a wrong one; staff have to fix the record.

The horizon is clamped to `visit.horizon_weeks` server-side even if the client
asks for a year, and every slot carries `isBookable`, which folds together
closed, full, and past-the-cutoff so the phone does not have to re-derive the
rule.

### Endpoints

Customer:

```
GET  /visits/rounds?prisonId
GET  /visits/availability?inmateId&from&to
POST /visits                               books; 409 when full, closed or late
GET  /visits?status&cursor
GET  /visits/{id}
POST /visits/{id}/cancel                   returns the seat in the same tx
```

Admin:

```
GET/POST /admin/visit-rounds  ·  PATCH/DELETE /admin/visit-rounds/{id}
GET/PUT  /admin/visit-templates  ·  DELETE /admin/visit-templates/{id}
GET  /admin/visit-schedule?from&to         the week grid
POST /admin/visit-schedule                 a manual cell
PATCH/DELETE /admin/visit-schedule/{id}
POST /admin/visit-schedule/generate        idempotent
POST /admin/visit-schedule/close           holiday / lockdown, a date range
GET  /admin/visits?date&status&zoneId&q&cursor
GET  /admin/visits/summary?from&to
GET  /admin/visits/{id}
POST /admin/visits/{id}/status             confirmed | checked_in | no_show | cancelled
POST /admin/visits/{id}/check-in
```

Roles: building the schedule is `prison_admin` and `super_admin` — it is the
facility's own decision. `zone_staff` works the gate: it reads the grid and the
booking list and checks people in, and cannot touch capacity. `super_admin` must
name a prison to edit a schedule; there is no department-wide calendar. Every
query goes through `prisonScope` / `resolvePrisonId` / `assertInScope`.

### Settings

| Key | Scope | Default | Why |
| --- | --- | --- | --- |
| `visit.horizon_weeks` | prison | 4 | how far ahead the job materializes and the family can see |
| `visit.booking_cutoff_hours` | prison | 24 | the gate needs a list the night before |
| `visit.max_visitors_per_booking` | prison | 3 | a gate-sheet fact, not a capacity one |
| `visit.default_capacity` | prison | 20 | what a new cell starts at |
| `visit.auto_confirm` | prison | true | off means staff confirm each booking by hand |
| `visit.reminder_hours` | prison | 24 | how far ahead `visit.reminder` fires |
| `visit.max_open_per_inmate` | prison | 2 | stops one family filling a month of slots |

The first two were declared back in Phase 0; the rest are new. Everything the
booking screen needs to state a rule *before* you break it is exposed to the
customer app.

### Jobs

`visit.schedule.materialize` — every active facility, one horizon each.
`visit.reminder` — bookings starting within `visit.reminder_hours`, one
notification per booking ever: `reminded_at` is the idempotency key, so a
scheduler firing hourly does not wake a family hourly. Both are enqueued by the
housekeeping tick alongside `session.purge`.

### Customer UI (LIFF)

`/visits` — pick the inmate (which picks the แดน, and therefore the calendar),
then a day-grouped grid of rounds showing **ว่าง n ที่** / **เต็มแล้ว** /
**เลยเวลารับจอง** / **งดเยี่ยม**. Choosing a slot opens the visitor details, and
the confirm button states the date, round and แดน it is about to book. If the
slot fills while the form is open, the 409 comes back with the availability
re-read underneath it, so the next tap is against fresh data.

`/visits/{id}` — the booking, what to bring, the booking number to read out at
the gate, and the cancel button while `canCancel` is still true.

### Admin UI

`/visits` — **the centrepiece screen.** Rounds down the left, seven dates across
the top, each cell a stack of แดน chips carrying `booked/capacity`. Click a chip
to edit capacity, แดน and note; right-click to close or reopen it; **+ เพิ่มแดน**
adds a cell to any (date, round). A cell a person has edited is marked `·✎`, a
full one turns red, a closed one goes dashed and struck through. Above it: week
navigation, **สร้างตารางล่วงหน้าจากแม่แบบ**, งดเยี่ยมทั้งสัปดาห์, and four tiles
including real capacity utilisation. Below it: the gate list for a chosen date,
with เช็คอิน on every live row and a drawer carrying the visitor details.

`/visits/rounds` — rounds CRUD, and the weekly template rendered as the p.12
grid itself: weekdays down, rounds across, a แดน picker and a capacity box in
each cell. It says out loud that editing the template changes nothing until you
press generate, and that pressing generate is safe.

## Decisions worth knowing

1. **Booking reads `visit_schedule_days` only.** Never the template, never a
   weekday rule at request time. This is what makes a manual override trivially
   correct and the capacity check a single-row update.
2. **The partial unique index**, above — §4.6's rule without the rebooking trap.
3. **A staff edit converts `template` → `manual`.** Not a flag the operator
   sets; a consequence of having touched the row. It cannot be forgotten.
4. **Closing beats deleting.** A generated row you delete comes back; a closed
   one stays closed and still tells the family why.
5. **A no-show holds its seat.** Attendance and capacity are different facts.
6. **Staff may cancel past the cutoff; families may not.** The cutoff exists so
   the gate has a stable list, and staff *are* the gate.
7. **`visitor_count` does not consume capacity.** A cell is a table in a visit
   room; capacity counts bookings. The head count is for the gate sheet, capped
   separately by `visit.max_visitors_per_booking`.
8. **super_admin must name a prison to edit a schedule.** A department-wide
   calendar is not a thing that exists, and silently defaulting to one facility
   would be worse than an error.

## Tests

`pnpm --filter @pc/api test` — 192 integration tests (159 from Phases 0–4, 33
new) against a real in-memory SQLite with the real migrations.

The new coverage: the seeded rounds listed and scoped; a duplicate round number
and a backwards time range both refused; a round created, edited, deleted, and
then a scheduled round refused deletion; `zone_staff` allowed to read rounds and
refused to write them; materialize idempotent on a second run; a staff-edited
cell surviving a re-run with its capacity, closure and `manual` source intact; a
wider horizon extending rather than rewriting; the grid returning exactly one
cell per (date, round, zone); a manual cell added, a duplicate of it refused,
and the cell deleted; a date range closed and reopened; capacity refused below
what is already booked; availability confined to the inmate's แดน and to the
facility horizon, with today's slots unbookable past the cutoff and an
unverified relative refused; a booking numbered `KLP-V…` moving the counter by
exactly one; a second live booking for the same inmate that day refused; a
closed slot and a foreign-แดน slot both refused; a booking inside the cutoff
refused; the visitor cap enforced; one relative refused another's booking;
**ten concurrent bookings against a three-seat cell producing exactly three
bookings and `booked_count == capacity`**; cancellation returning the seat in
the same transaction and the day becoming rebookable; check-in, then cancel
refused; a no-show holding its seat; an impossible status transition refused;
staff cancelling past the cutoff where the family cannot; cross-prison scoping
on the list, the calendar and the detail read; the summary counting live and
honoured bookings but not cancellations; and the reminder job notifying once and
never twice.

## Seed

Four rounds per facility (two morning, two afternoon), a Mon–Fri template
rotating แดน across rounds, and the four-week horizon materialized once — 8
rounds, 40 template cells and 160 calendar cells, so both the week grid and the
booking screen open on real data.

The seed's dev-data wipe also gained the letter, payment and visit tables. It
had been failing on a re-seed since Phase 4: `letter_purchases` and `payments`
hold `restrict` foreign keys back to `customers`, so the wipe died halfway
through. `pnpm db:seed` is idempotent again.

## Next: Phase 6 — News + Dashboard + Reports

News CRUD, the four p.11 dashboard tiles with a period selector, and all seven
p.12 XLSX reports through the job queue. `visitTotals` is already the shape the
visit report needs; run `EXPLAIN QUERY PLAN` over every report query as §5 asks.
