#!/usr/bin/env bash
# Restore drill (Phase 7).
#
# Restores the newest Litestream replica into a THROWAWAY directory, runs the
# integrity and freshness checks, and prints a pass/fail line. It never touches
# /data — a drill that could damage production is a drill nobody runs.
#
# Run it **on the VPS host**, from the repository root. It needs the two single
# binaries the drill is about — `litestream` and `sqlite3` — which are not in
# the API image on purpose: the app has no business holding a restore tool.
#
#   set -a; . docker/.env; set +a          # LITESTREAM_* credentials
#   ./docker/restore-drill.sh
#   ./docker/restore-drill.sh --keep       # leave the restored copy for poking at
#
# Run it monthly and after every change to the replica configuration. A backup
# nobody has restored is a hypothesis, not a backup.

set -euo pipefail

WORKDIR="${RESTORE_DIR:-/tmp/restore-drill-$(date +%s)}"
CONFIG="${LITESTREAM_CONFIG:-docker/litestream.yml}"
# The path as it appears in litestream.yml — it is the replica's key, not a
# file that has to exist on this machine.
SOURCE="${DATABASE_PATH:-/data/app.db}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-apps/api/src/db/migrations}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  [ "$KEEP" -eq 1 ] && { echo "restored copy kept at $WORKDIR"; return; }
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$WORKDIR"
RESTORED="$WORKDIR/app.db"

echo "── restore drill ────────────────────────────────────────────"
echo "source   $SOURCE"
echo "target   $RESTORED"
echo

# 1. Restore. `-if-replica-exists` turns "no replica configured" into a clear
#    failure here rather than an empty database that passes every later check.
echo "[1/5] restoring newest replica…"
litestream restore -config "$CONFIG" -if-replica-exists -o "$RESTORED" "$SOURCE"
[ -s "$RESTORED" ] || { echo "FAIL: restored file is empty"; exit 1; }

# 2. Structural integrity. A silently corrupt page is exactly what a drill is
#    for; `integrity_check` is the only thing that finds it before a customer does.
echo "[2/5] integrity_check…"
RESULT=$(sqlite3 "$RESTORED" 'PRAGMA integrity_check;')
[ "$RESULT" = "ok" ] || { echo "FAIL: integrity_check → $RESULT"; exit 1; }

# 3. Foreign keys. Money rows pointing at deleted parents would not raise a
#    single error at read time — they just quietly wreck the reports.
echo "[3/5] foreign_key_check…"
FK=$(sqlite3 "$RESTORED" 'PRAGMA foreign_key_check;' | head -5)
[ -z "$FK" ] || { echo "FAIL: foreign key violations:"; echo "$FK"; exit 1; }

# 4. Schema version. The restored file must be at the same migration as the
#    code that will open it, or the first write fails in production.
echo "[4/5] migration state…"
APPLIED=$(sqlite3 "$RESTORED" "SELECT COUNT(*) FROM __drizzle_migrations;" 2>/dev/null || echo 0)
EXPECTED=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l || echo 0)
echo "        applied=$APPLIED expected=$EXPECTED"
if [ "$EXPECTED" -gt 0 ] && [ "$APPLIED" -ne "$EXPECTED" ]; then
  echo "FAIL: restored database is $((EXPECTED - APPLIED)) migration(s) behind"
  exit 1
fi

# 5. Freshness + a business row count, so the output says something a human can
#    judge: "how much would we have lost if we had restored right now?"
echo "[5/5] freshness…"
LATEST=$(sqlite3 "$RESTORED" "SELECT COALESCE(MAX(created_at), 0) FROM audit_logs;")
NOW=$(( $(date +%s) * 1000 ))
LAG=$(( (NOW - LATEST) / 1000 ))
ORDERS=$(sqlite3 "$RESTORED" "SELECT COUNT(*) FROM orders;")
PAYMENTS=$(sqlite3 "$RESTORED" "SELECT COUNT(*) FROM payments;")

echo
echo "orders            $ORDERS"
echo "payments          $PAYMENTS"
echo "newest audit row  ${LAG}s ago"

# Litestream syncs every 10s; a minute of lag is normal, ten is not.
if [ "$LAG" -gt 600 ]; then
  echo "FAIL: replica is more than 10 minutes stale — check the litestream container"
  exit 1
fi

echo
echo "PASS — restore drill completed $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Record the result in docs/RUNBOOK.md § drill log."
