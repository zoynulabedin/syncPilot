#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_path="${1:?Usage: bash scripts/restore-drill.sh backups/file.dump}"
test_database="syncpilot_restore_test_$(date -u +%s)"
case "$test_database" in syncpilot_restore_test_[0-9]*) ;; *) exit 2 ;; esac
cleanup() { docker compose exec -T postgres dropdb -U syncpilot --if-exists "$test_database" >/dev/null; }
trap cleanup EXIT
docker compose exec -T postgres createdb -U syncpilot "$test_database"
docker compose exec -T postgres pg_restore -U syncpilot --dbname="$test_database" --exit-on-error < "$backup_path"
docker compose exec -T postgres psql -U syncpilot -d "$test_database" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS applied_migrations FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'
echo "Restore rehearsal passed in disposable database; application database was not changed."
