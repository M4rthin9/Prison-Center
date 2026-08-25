# Phase 0b — Inmate data

> **Done when:** a DOC-shaped export imports twice with zero duplicates and a
> readable diff.

Verified against the seeded database: an XLSX with a merged title row above the
header imports cleanly, the identical file imported a second time produces
`created 0 / updated 0 / skipped N`, and every row a human has to look at comes
back as a downloadable XLSX.

## What exists

### Database (`0003_phase0b_inmate_import`)

The Phase 0 schema already carried `inmates.external_id` / `external_source` /
`synced_at` / `sync_hash` / `is_locally_edited` and the two run tables. This
migration adds three columns to `inmate_import_runs`:

| Column | Why |
| --- | --- |
| `file_name` | what the clerk called it — the only human handle on a run |
| `file_hash` | SHA-256 of the upload; `apply` refuses if the stored bytes changed |
| `options_json` | the options the dry run was computed with, so apply reuses them verbatim |

`inmate_import_rows.raw_json` keeps every original cell, mapped or not. That is
what the error report is rebuilt from, and it is why an unrecognised column is
never silently discarded.

### Two steps, never one

`POST /admin/inmates/import` **never writes to `inmates`.** It parses, plans,
stores the file, writes the run + per-row diff, and returns the preview. A
second call, `POST /admin/inmates/import/{runId}/apply`, re-reads the file from
storage, checks the hash, **re-plans against the database as it is now**, and
writes inside one `BEGIN IMMEDIATE` transaction. The counts in the apply
response are what actually happened, not what the preview predicted — a preview
that has gone stale cannot commit a stale decision.

A run can be applied exactly once (409 on the second attempt).

### The parser (`lib/import/table.ts`)

One shape for both formats: a header row and string cells.

- **XLSX** via ExcelJS. The header is the first row with two or more non-empty
  cells, because the real export has a merged title row above it. Dates,
  formulas and rich text are flattened to strings here so nothing downstream
  cares what the cell was.
- **CSV** with a sniffed delimiter (`,` `;` tab `|`) and full RFC 4180 quoting.
- **TIS-620.** UTF-8 is tried first and accepted only if it round-trips; a
  U+FFFD anywhere means the file is legacy and it is re-decoded as
  `windows-874`. Thai government exports still ship this way (§13 unknown #1).
- Thai numerals are folded to Arabic, whitespace collapsed, duplicate headers
  disambiguated rather than allowed to overwrite each other.

### The mapper

A synonym table, not a schema — the DOC column names are still unknown, so the
mapper recognises both English and Thai spellings of eight fields
(`external_id`, `เลขทะเบียน`, `ชื่อ-สกุล`, `แดน`, `กองงาน`, `สถานะ`,
`วันพ้นโทษ`, `รหัสเรือนจำ`). A file with no name column, or with neither a
registration number nor a reference id, is refused outright with a Thai
sentence. Everything unmapped is listed in the preview and kept in `raw_json`.

Statuses are matched against both languages (`ปกติ` → `active`, `ย้าย` →
`transferred`, `พ้นโทษ` → `released`, `เสียชีวิต` → `deceased`); an unknown word
is a row error, never a guess. Dates accept ISO and `31/12/2568`, with the
Buddhist year converted on the way in.

### Matching and the diff

Match order is `(external_source, external_id)` first, then
`(prison_id, inmate_code)`. Every row lands in exactly one of five buckets:

| Result | Meaning |
| --- | --- |
| `created` | no match — a new inmate |
| `updated` | matched and something differs; the message names each field that moves |
| `skipped` | `sync_hash` identical — not one write is issued |
| `conflict` | the row cannot be applied without a human decision |
| `error` | the row is not valid data |

`sync_hash` is the fingerprint of the incoming row. It is what makes the second
import of an unchanged file cost zero writes and produce an empty diff.

Conflicts, specifically: the same reference id or registration number twice in
one file; a registration number that already belongs to a different person at
that facility; a registration number bound to a different reference id; a `แดน`
that does not exist (unless `createZones` is on); and a row whose
`รหัสเรือนจำ` names a different facility — that file belongs to that
facility's staff, not to this import.

### Rules the importer will not break

1. **A staff correction outranks the file.** Any manual edit sets
   `is_locally_edited`, and from then on the importer updates that inmate's zone,
   status and registration number but leaves the **name** alone. The preview says
   so in the row message.
2. **Nothing is ever deleted.** An inmate held at the facility but absent from
   the file is reported as *missing* and, by default, not touched at all. A
   truncated export is a much likelier explanation than a mass release. Setting
   `missingPolicy=mark_transferred` marks them `transferred` — still a status
   change, still reversible, still no row removed.
3. **Transfers happen at the receiving end.** An inmate matched by reference id
   whose stored prison differs from the import target is *moved in*: prison and
   zone are updated, the row message says `ย้ายมาจาก…`, and every historical
   order, letter and deposit keeps the zone it was created against (§4.1).
4. **Soft delete only.** `DELETE /admin/inmates/{id}` sets `deleted_at`, and
   refuses outright while the inmate has an unpaid or awaiting-verify order.

### Error report

Every run with conflicts or errors gets an XLSX written to storage and recorded
in `error_report_key`: row number, result, reason, then every original column.
The clerk fixes it in Excel and re-uploads it — which is why the original cells
are carried through verbatim. It is served through the API
(`GET /admin/inmates/import-runs/{id}/errors.xlsx`), not from a public URL: it
is a list of named people.

### Inmate CRUD

`GET/POST /admin/inmates`, `GET/PATCH/DELETE /admin/inmates/{id}`,
`POST /admin/inmates/{id}/restore`, `POST /admin/inmates/{id}/transfer`. List
filters: prison, zone, status, free-text over name and registration number,
`includeDeleted`. Keyset pagination on `(inmate_code, id)` ascending — the order
a clerk reads.

Everything is scoped by the caller's prison through `prisonScope` /
`resolvePrisonId` / `assertInScope`. Writes are `super_admin` and
`prison_admin` only; `zone_staff` and `finance` may read. A `prison_admin`
cannot transfer someone **into** a facility they do not administer — that
import belongs to the receiving prison's staff.

### Admin UI

`/inmates` — filterable roster with inline edit, transfer, soft delete and
restore, showing per row whether the record came from the DOC file or was
entered by hand.

`/inmates/import` — pick a file, choose the source key, whether to create
missing แดน, and what to do with inmates absent from the file. Then: five
counters, a filter by result, the per-row diff with a Thai reason on each row,
the error-report download, and a **ยืนยันการนำเข้า** button that is disabled
when there is nothing to write. Below it, the last ten runs, each reopenable.

## Decisions worth knowing

1. **`apply` re-plans, it does not replay.** Storing the plan and executing it
   later would let two clerks apply two stale previews on top of each other.
   Re-planning from the same bytes is a few milliseconds and removes the class.
2. **`external_source` is part of the identity.** Matching is
   `(source, external_id)`, so changing the source key on the import screen
   deliberately starts a fresh data set rather than colliding with the old one.
3. **`createZones` defaults off.** A แดน nobody recognises is usually a typo in
   the export, and a facility's zone list is master data a `prison_admin` should
   choose to extend.
4. **Missing rows are surfaced but never actioned by default.** The count is in
   the preview; the sweep is opt-in per run.
5. **ExcelJS reads *and* writes here.** It is the same dependency Phase 6 needs
   for the seven XLSX reports, so the import error report costs nothing extra.

## Tests

`pnpm --filter @pc/api test` — 114 integration tests (91 from Phases 0–2, 23 new)
against a real in-memory SQLite with the real migrations.

The new coverage: the scoped roster in registration-number order, cross-facility
refusal, create/edit setting `is_locally_edited`, the duplicate registration
number, `zone_staff` refused a write, soft delete hiding a row and `restore`
bringing it back, delete refused while an order is unpaid, a transfer clearing
the zone, a `prison_admin` refused a transfer into another facility, a dry run
writing nothing, an XLSX with a title row above the header, the same file twice
producing `0/0/2`, a TIS-620 file decoded without mojibake, a rename applied and
then a staff correction surviving the next import while the zone still moves, an
unknown แดน as a conflict and then created on request, a reference id twice in
one file, a stolen registration number, a nameless row and an unreadable status,
the XLSX error report's contents, a cross-facility move landing at the receiving
prison, a partial file leaving the roster alone and then sweeping it only when
asked, the second apply refused, a file with no usable columns, and import
history scoped per facility.

## Next: Phase 3 — Deposits

`deposit_cards`, the deposit flow reusing the Phase 2 payment spine
(`purpose='deposit'` is already in `supports_purposes_json` on the seeded
channels), and the admin review queue.
