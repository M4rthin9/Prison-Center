#!/bin/bash
# One container, two processes. If either dies the container exits so the
# restart policy recycles the whole thing — no half-up stack.
set -e

mkdir -p /data/uploads

cd /app
pnpm --filter @pc/api start &
API_PID=$!

caddy run --config /etc/caddy/Caddyfile &
CADDY_PID=$!

trap 'kill -TERM $API_PID $CADDY_PID 2>/dev/null' TERM INT
wait -n $API_PID $CADDY_PID
kill -TERM $API_PID $CADDY_PID 2>/dev/null || true
exit 1
