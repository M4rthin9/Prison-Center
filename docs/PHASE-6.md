# Phase 6 — News + Dashboard + Reports

> **Done when:** every report opens in Excel with correct Thai headers and
> matching totals.

Verified against the seeded database: all seven p.12 reports queue as jobs,
generate real `.xlsx` files (title row, filter line, generated-at stamp, Thai
headers, bold totals), and download through the admin session. The four p.11
dashboard tiles count from the business tables at read time, and an integration
test asserts the dashboard's paid-sales figure equals the sum of the sales
report's paid rows over the same window. Staff write ข่าวสาร in the dashboard;
relatives read it in the customer app without a session.

## What exists

### Database (`0007_phase6_news`, `0008_phase6_report_indexes`)

`news` — §4.7, one table: `title`, `slug UNIQUE`, `excerpt`,
`cover_image_key`, `body_html`, `status ∈ draft|published|archived`,
`published_at`, `is_pinned`, `author_staff_id`, and a nullable `prison_id`
where **NULL means a department-wide notice visible from every prison**.

Indexes: `uq_news_slug`, `idx_news_feed`
(`status, prison_id, is_pinned, published_at` — the customer feed) and
`idx_news_admin`.

**No `reports` table.** A report *is* a `jobs` row: the payload holds the kind
and the filters, the result holds the file key, row count and byte size. That
means a report can always be traced back to exactly what was asked for, and
there is no second place for its status to drift out of sync with the queue.

`0008` adds five single-column range indexes —
`orders(ordered_at)`, `payments(created_at)`, `deposits(created_at)`,
`letters(created_at)`, `visit_bookings(visit_date)`. See *Query plans* below.

### The seven reports

Raw SQL, one file per report in `modules/reports/queries/*.sql`, exactly as §7
asks: these are the queries that get disputed by an auditor, and a file you can
paste into a sqlite shell is worth more than a query builder that produces the
same rows.

| # | File | Grain |
|---|---|---|
| 1 | `sales.sql` | order |
| 2 | `sales_detail.sql` | order line |
| 3 | `products.sql` | สินค้า × แดน × กองงาน, paid orders only |
| 4 | `visits.sql` | prison × แดน × รอบ × period |
| 5 | `letters.sql` | prison × แดน × direction × period |
| 6 | `payments.sql` | period × channel × rail × purpose |
| 7 | `deposits.sql` | prison × แดน × period |

Every query takes the same named-parameter vocabulary — `:prison_id`,
`:zone_id`, `:shop_id`, `:from_ms`, `:to_ms`, `:from_date`, `:to_date`,
`:group_fmt` — and **the bind object is derived from the SQL text**, because
better-sqlite3 throws on a named parameter the statement never mentions and not
every report needs every filter.

Thai month grouping is §7's expression verbatim:
`strftime(:group_fmt, datetime(ts/1000,'unixepoch','+7 hours'))`, with
`'all'` as the sentinel for "do not split the period". `visits.sql` skips the
timezone shift because `visit_date` is already a Bangkok `YYYY-MM-DD`.

Buddhist-era years are applied in `service.ts` when the cell is written, never
in SQL and never in storage.

### The workbook

`definitions.ts` holds the Thai headers, column widths and per-column format
(`money | datetime | period | int | text`) for each report; `service.ts` turns
rows into a sheet. Every sheet gets:

1. the report title, 16pt bold;
2. the filters that produced it — prison, date range, grouping;
3. `ออกรายงานเมื่อ … · โดย …`, plus the grain note where the grain is not
   obvious;
4. a frozen, filled, auto-filtered header row at row 5;
5. a bold totals row over the columns each report declares as summable.

Satang become baht (`#,##0.00`) at exactly one place: `cellValue`. An empty
result set writes `ไม่พบข้อมูลในช่วงเวลาที่เลือก` rather than a bare header row,
which reads like a bug.

### Async, through the existing queue

`POST /admin/reports/{kind}` validates the range, stamps the requesting staff
member's name into the payload (so the sheet still says who ran it after that
account is deactivated), enqueues `report.generate` with `maxAttempts: 1`, and
returns `202` with the job. The admin screen polls until `succeeded`.

One attempt, not five: a report that failed on a bad range will fail
identically four more times while a staff member watches the row.

The XLSX is streamed back through `GET /admin/reports/{jobId}/download` with
the session, never from the public `/files` path — these sheets carry names,
phone numbers and amounts. Thai filenames go out as RFC 5987 `filename*`.

### Dashboard

`GET /admin/dashboard/summary?period&from&to` — one request feeds all four
tiles, the daily chart and the work queues.

The period selector resolves in **Bangkok wall-clock time** (`resolveWindow`):
`today | week | month | year | custom`. Timestamps are stored UTC, and a
"today" that starts at 07:00 local is the classic way a tile ends up
disagreeing with the list underneath it.

- **คำสั่งซื้อ** — count, paid count, `paidSatang` (settled money only, which is
  the only sales figure finance will accept), and orders awaiting fulfillment.
- **การจองเยี่ยม** — booked against capacity, with utilisation. Cancellations
  gave their seat back and do not inflate it; a no-show did not.
- **จดหมาย** — by direction and status, plus coupon revenue.
- **การฝากเงิน** — received (slip verified, credited or not) and completed.

`series` returns **one point per Bangkok day, including empty days** — a chart
that silently drops quiet days lies about the shape of the week. Visits are
counted on the day of the visit, not the day of the booking, because that is
the number the gate staff recognise.

`queues` is deliberately **not** period-filtered: it is work waiting on a human
right now, and a period selector that could hide a backlog would be a trap.

### News

Public: `GET /news?prisonId&cursor` and `GET /news/{slug}`, no session — p.13
puts ข่าวสาร next to เกี่ยวกับเรา, and someone deciding whether to register
should be able to read the announcements first. Keyset cursor over
`(is_pinned, published_at, id)`, the same tuple as the `ORDER BY`, so a notice
pinned mid-scroll cannot make the reader skip a page.

Admin: `CRUD /admin/news` + cover upload, `super_admin | prison_admin` only.

**`body_html` is sanitized on write, once, by the server** — allowlist of
`p, br, strong, b, em, i, u, s, h2-h4, ul, ol, li, blockquote, hr, figure,
figcaption, a, img`, everything else dropped and its text escaped. Sanitizing
at render time means every future reader has to remember to, and one who forgets
is stored XSS in an app holding family phone numbers. `javascript:` and `data:`
URLs are refused; external links get `target="_blank" rel="noopener noreferrer"`
so a link cannot strand a reader inside the LINE webview.

Covers go through the same EXIF-stripping pipeline as letter photos. That
pipeline moved from `lib/letters/image.ts` to `lib/image.ts`
(`normalizeImage`); the letters module re-exports the old name.

## Query plans (§5's homework)

`EXPLAIN QUERY PLAN` over all seven queries found the driving table being
scanned in five of them. Cause: `(:prison_id is null or x.prison_id = :prison_id)`
— the idiom that makes one file serve both the department-wide and the scoped
report — is opaque to the planner, so the composite `(prison_id, date)` indexes
from §5 could not be used, and no index led with the date column alone.

`0008` adds those five single-column indexes. Every scan became a range search:

```
SCAN d                → SEARCH d USING INDEX idx_deposits_created (created_at>? AND created_at<?)
SCAN o                → SEARCH o USING INDEX idx_orders_ordered_at (ordered_at>? AND ordered_at<?)
SCAN vb               → SEARCH vb USING INDEX idx_visit_bookings_date (visit_date>? AND visit_date<?)
```

`products.sql` already drove off `idx_orders_paystatus`. The remaining
`USE TEMP B-TREE FOR GROUP BY` is inherent to grouping on a computed period
expression and is not worth an expression index at this data volume.

## Decisions

1. **A report is a job row, not a `reports` table.** One source of truth for
   status, and the filters travel with the file forever.
2. **Raw SQL in `.sql` files.** §7's instruction, and the right call: these are
   the queries you debug in a sqlite shell at 4pm with an auditor on the phone.
3. **The bind set is derived from the SQL text.** Otherwise every query has to
   mention every parameter it does not use, purely to satisfy the driver.
4. **`prison_id IS NULL` = department-wide** for news, matching payment channels
   and letter packages. Only `super_admin` can write one — a `prison_admin`
   editing it would be editing every other facility's front page.
5. **A published post's slug never moves.** A draft's slug still tracks its
   title; once it is live the URL is already in someone's LINE chat.
6. **`published_at` is stamped once.** Editing a live post must not re-float it
   to the top of the family's feed.
7. **Sanitize on write.** See above.
8. **Reports are `super_admin | prison_admin | finance`.** `zone_staff` and
   `letter_operator` run the floor; they do not export the department's numbers.
9. **`UpdateNewsInput` is spelled out rather than `CreateNewsInput.partial()`.**
   Zod's `.default()` survives `.partial()`, so a PATCH that changed only the
   title silently pushed a published post back to draft. Caught by a test.

## Tests

`pnpm --filter @pc/api test` — 233 integration tests (192 from Phases 0–5, 41
new) against a real in-memory SQLite with the real migrations.

New coverage: the sanitizer keeping allowlisted tags, dropping `<script>` while
escaping its text, stripping `onclick` and `javascript:`, adding
`rel="noopener noreferrer"`, closing dangling tags, and refusing a body that is
empty once the tags are gone; Thai tone marks surviving slugification; a draft
invisible in the public feed; publishing stamping `published_at` once and
holding both it and the slug across an edit; duplicate titles getting distinct
slugs; a `prison_admin` refused a department-wide notice; a department-wide
notice appearing under every prison filter; a delete making the public URL
404; a `letter_operator` refused the editor; each of the seven queries running
against a real database with **every declared column actually present in its
result**; parameter binding limited to the names a query mentions; a prison
filter narrowing rows and never borrowing another facility's; Buddhist-era
period and timestamp formatting; **all seven reports queued, generated, and
downloaded as a real zip-magic `.xlsx`**; a download refused before the job
runs; a reversed range refused before a job row exists; another prison's report
hidden from a scoped account on read, download and list; a `letter_operator`
refused the export; the dashboard returning four tiles, one series point per
day and the queues; **the dashboard's order count and paid total matching the
sales report over the same window**; `period=custom` with no dates refused; and
a prison account refused another prison's dashboard.

## Seed

Three news rows: one pinned department-wide notice, one published prison
notice, one draft — so the customer feed, the pinned state and the draft filter
are all exercisable on a fresh install. The dev-data wipe gained `news`, which
holds a `restrict` FK back to `prisons`.

## Known gap, not introduced here

Admin screens that link to an authenticated file with a plain `<a href>` —
the letter batch PDF, the slip image, the inmate import error report — do not
carry the access token, which lives in a closure rather than a cookie. The
reports screen fetches the blob through the API client instead and hands the
browser an object URL. The three older links deserve the same treatment.

## Next: Phase 7 — LINE + hardening

LIFF wrapper, `LineIdTokenProvider`, account linking, Messaging API push, rich
menu, self-service OTP reset, rate limiting, the PDPA retention job, a load
test, a restore drill and the runbook.
