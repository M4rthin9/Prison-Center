# Runbook — ศูนย์บริการระบบโปรแกรมจำหน่ายสินค้าเรือนจำ

> Single VPS, in-country (decision #5). One API process, Caddy in front,
> Litestream replicating the SQLite file off-box. Everything below assumes that
> shape and stops working the moment there are two API replicas.

**The one rule:** there is exactly one writer. Never set `deploy.replicas`,
never run the API under `cluster`, never start a second container against the
same `/data/app.db`. WAL survives concurrent *readers*, not two processes
racing on the same write lock across a bind mount.

## Contents

1. [Layout](#layout)
2. [Deploy](#deploy)
3. [Health checks](#health-checks)
4. [Backup and restore](#backup-and-restore)
5. [The restore drill](#the-restore-drill)
6. [Incidents](#incidents)
7. [LINE](#line)
8. [PDPA retention](#pdpa-retention)
9. [Load test](#load-test)
10. [Drill log](#drill-log)

---

## Layout

| Piece | Where | Notes |
|---|---|---|
| API | `api` container, port 8787 | one process; the queue runs in-process |
| Customer app | `liff` container | static build behind Caddy |
| Admin app | `admin` container | static build; put it behind the office allowlist |
| Database | `app_data:/data/app.db` | SQLite, WAL |
| Uploads | `app_data:/data/uploads` | slips, letter scans, report files |
| Replica | Litestream → S3-compatible bucket | `docker/litestream.yml` |
| Outbox | `/data/outbox.log` | notification payloads when `NOTIFIER_ADAPTER=console` |

Uploads are **not** covered by Litestream. A restored database pointing at
missing slip images is a compliance problem, so `/data/uploads` needs its own
restic/rclone schedule to the same bucket.

## Deploy

Images are built by CI on push to `main` and pulled on the box — nothing is
compiled in production.

```sh
docker login                                    # once
git pull
docker compose -f docker/compose.yml pull
docker compose -f docker/compose.yml up -d
```

Migrations run at boot (`runMigrations` in the API entrypoint). They are
forward-only. **Take a manual snapshot before deploying a migration:**

```sh
docker compose -f docker/compose.yml exec api \
  sh -c 'sqlite3 /data/app.db ".backup /data/pre-deploy-$(date +%F).db"'
```

Rollback is: stop the API, restore that file over `/data/app.db`, start the
previous image tag. There is no down-migration path and there should not be.

## Health checks

```sh
curl -fsS https://<host>/health                       # {"ok":true,...}
docker compose -f docker/compose.yml logs -f api      # request log + job log
docker compose -f docker/compose.yml logs litestream  # "sync" lines every ~10s
```

Queue state, from a shell on the box:

```sh
docker compose -f docker/compose.yml exec api sh -c \
  "sqlite3 /data/app.db \"SELECT kind, status, COUNT(*) FROM jobs GROUP BY 1,2;\""
```

`failed` rows are the ones that matter: they exhausted their attempts and are
waiting for a human. `letter.batch_pdf` failures also park the error on the
batch itself, which is the screen the operator is already looking at.

## Backup and restore

Litestream replicates continuously (`sync-interval: 10s`, 30-day retention).
To restore into a scratch file:

```sh
litestream restore -config docker/litestream.yml -o /tmp/check.db /data/app.db
```

`/data/app.db` here is the *replica key* from `litestream.yml`, not a file on
the machine running the command.

To restore **over production** — only after the API is stopped:

```sh
docker compose -f docker/compose.yml stop api
docker compose -f docker/compose.yml exec litestream \
  litestream restore -config /etc/litestream.yml -o /data/app.db.restored /data/app.db
# inspect it, then swap:
docker compose -f docker/compose.yml exec litestream \
  sh -c 'mv /data/app.db /data/app.db.broken && mv /data/app.db.restored /data/app.db'
docker compose -f docker/compose.yml start api
```

Keep `app.db.broken`. It is the only evidence of whatever went wrong.

## The restore drill

`docker/restore-drill.sh` restores the newest replica into a throwaway
directory and checks it five ways: the file is non-empty, `integrity_check` is
`ok`, `foreign_key_check` is silent, the migration count matches the shipped
migrations, and the newest audit row is less than ten minutes old.

Run it on the host, from the repository root — it needs `litestream` and
`sqlite3`, which are deliberately absent from the API image:

```sh
set -a; . docker/.env; set +a      # LITESTREAM_* credentials
./docker/restore-drill.sh
```

Run it **monthly** and after every change to the replica configuration, then
add a line to the [drill log](#drill-log). A backup nobody has restored is a
hypothesis, not a backup.

## Incidents

### The API will not start

Read the logs first — the env schema fails loudly and names the key. The
production guards that reject a boot are: the dev `JWT_SECRET`, `COOKIE_SECURE`
off, empty `CORS_ORIGINS`, and `OTP_ECHO` on.

### `database is locked`

Something else has the write lock. Check for a second API container, a stray
`sqlite3` shell, or a backup command still running. `busy_timeout` is 5s, so a
persistent error means a *held* lock, not a busy one.

### The queue has stopped

`requeueStale()` reclaims jobs orphaned by a crash after 10 minutes, and
housekeeping runs hourly. If nothing is moving, the API process is wedged:
restart it. Jobs are claimed with `BEGIN IMMEDIATE`, so a restart mid-job is
safe — the row goes back to `pending`.

### A relative cannot log in

Lockout is 5 failures → 15 min, doubling to a 24h cap. It clears on a
successful login or a staff-assisted reset (`prison_admin` → บัญชีญาติ → ตั้ง
รหัสผ่านชั่วคราว). Per-IP throttles live in `rate_limits`; a blocked office NAT
looks like "everyone at that address is locked out at once":

```sh
sqlite3 /data/app.db "DELETE FROM rate_limits WHERE key LIKE 'login:%ip:203.0.113.7';"
```

### Disk full

WAL checkpoints every 1000 pages, so the `-wal` file is not usually the
culprit. Look at `/data/uploads` (slips and letter scans) and the report files
under it. The PDPA retention job is what removes them on a schedule.

## LINE

Two separate LINE channels, and mixing them up is the most common setup error:

| Channel | Env | Used for |
|---|---|---|
| LINE Login (LIFF) | `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LIFF_ID` | verifying ID tokens for login and linking |
| Messaging API | `LINE_MESSAGING_TOKEN` | push notifications, rich menu |

Turning LINE on, in order:

1. Set the env vars above and restart the API.
2. Settings Registry: `features.line_login = true`, `line.liff_id = "<LIFF_ID>"`.
3. `NOTIFIER_ADAPTER=line` to enable push (in-app notifications keep working
   either way — push is layered on top, never in place of).
4. Rich menu: `pnpm --filter @pc/api rich-menu -- ./menu.png` with a 2500×843
   PNG. The id is stored in `line.rich_menu_id` and the previous menu is
   deleted only after the new one is live.

**Push failures.** Every push is a `line.push` job whose outcome is written
back onto the in-app notification row. A permanent failure (the relative
blocked the bot, or the `line_user_id` is stale) is recorded and *not* retried;
a 429 or 5xx goes back for the usual backoff. To see them:

```sh
sqlite3 /data/app.db \
  "SELECT kind, error, COUNT(*) FROM notifications WHERE error IS NOT NULL GROUP BY 1,2;"
```

**Turning LINE off** is one setting: `features.line_login = false`. Existing
links stay in the database; relatives fall back to phone + password, which is
still their account. Nothing is lost.

## PDPA retention

Windows are Settings Registry keys (`pdpa.retention.*`) and need departmental
sign-off before the purge runs for real. The job is `pdpa.retention`, enqueued
daily at 03:00 Bangkok, and the admin screen is **ลบข้อมูลตามระยะเวลา**
(super_admin only).

Switching it on:

1. Leave `pdpa.retention.enabled = false`. Run the preview weekly for a month
   and confirm the row counts match what the department expects.
2. Get the windows signed off; record the decision.
3. `pdpa.retention.enabled = true`, `pdpa.retention.dry_run = false`.

What it does *not* do: delete a customer row. A closed account is anonymized —
username replaced with `deleted-<id>`, personal columns cleared, the row kept
so no financial record is orphaned.

## Load test

```sh
pnpm --filter @pc/api loadtest -- --base https://<host> --duration 60 --readers 40
```

Prints throughput and p50/p95/p99, and exits non-zero on any 5xx or connection
failure. A 429 is a *result*, not a failure — rate limiting is part of what is
being measured. Run it against a staging box, never against production during
office hours.

## Drill log

Append one line per drill. Empty until the first real rehearsal on the VPS.

| Date | Operator | Result | Restore lag | Notes |
|---|---|---|---|---|
| | | | | |
