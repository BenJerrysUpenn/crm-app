#!/usr/bin/env bash
# Applies every time-app migration, in order, to a throwaway local Postgres and
# runs every supabase/migration_*_verify.sql against it. Nothing touches a real
# project: the cluster lives in a temp directory and is deleted on exit.
#
#   time-app/supabase/local/verify.sh          (needs initdb, pg_ctl, psql;
#                                               brew install postgresql@14)
#
# stub.sql stands in for the Supabase pieces the migrations use (API roles,
# auth.uid(), default grants); users.sql adds the logins before the
# migrations and seed.sql their roles after. Exit status is
# non-zero if any migration fails to apply or any verify file raises.
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null || { echo "needs $bin on PATH (brew install postgresql@14)"; exit 2; }
done

TMP=$(mktemp -d /tmp/wtv.XXXXXX)   # short: a Unix socket path is capped at 103 bytes
PORT=${VERIFY_PG_PORT:-55439}
cleanup() { pg_ctl -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

initdb -D "$TMP/data" -U postgres --auth=trust >/dev/null
pg_ctl -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f local/stub.sql
"${PSQL[@]}" -f local/users.sql
for f in $(ls migration*.sql | grep -v -e _verify -e _down | sort -V); do
  if ! "${PSQL[@]}" -f "$f" >/dev/null 2>"$TMP/err"; then
    cat "$TMP/err"; echo "FAILED applying $f"; exit 1
  fi
done
"${PSQL[@]}" -f local/seed.sql

fail=0
for f in $(ls migration_*_verify.sql | sort -V); do
  if out=$("${PSQL[@]}" -f "$f" 2>&1); then
    echo "ok    $f  ($(echo "$out" | grep -o 'migration [0-9]* verified.*' | head -1))"
  else
    echo "FAIL  $f"; echo "$out" | grep -E 'ERROR|CONTEXT' | head -3; fail=1
  fi
done
exit $fail
