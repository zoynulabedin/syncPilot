#!/usr/bin/env bash
# SyncPilot macOS/Linux development checks.
# Only local tooling/database when explicitly requested; no Shopify writes.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1

SKIP_INSTALL=false
WITH_MIGRATION=false
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=true ;;
    --with-migration) WITH_MIGRATION=true ;;
    -h|--help)
      echo "Usage: bash scripts/local-check.sh [--skip-install] [--with-migration]"
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Node.js, npm and npx must be installed." >&2
  exit 1
fi

mkdir -p local-check-results
SUMMARY="local-check-results/summary.txt"
: > "$SUMMARY"
failures=0

run_check() {
  local name="$1"
  shift
  echo "Running $name..."
  if "$@" > "local-check-results/$name.stdout.log" 2> "local-check-results/$name.stderr.log"; then
    echo "PASS $name" | tee -a "$SUMMARY"
  else
    local code=$?
    echo "FAIL $name (exit $code)" | tee -a "$SUMMARY"
    echo "See local-check-results/$name.stderr.log"
    failures=$((failures + 1))
  fi
}

if [ "$SKIP_INSTALL" = false ]; then
  run_check "npm-install" npm ci
fi
if [ ! -d node_modules ]; then
  echo "Missing node_modules; install dependencies first." | tee -a "$SUMMARY"
  exit 1
fi
run_check "prisma-generate" npx prisma generate
run_check "prisma-validate" npx prisma validate
run_check "typecheck" npm run typecheck
run_check "build" npm run build

if [ "$WITH_MIGRATION" = true ]; then
  if [ -z "${DATABASE_URL:-}" ] && [ ! -f .env ]; then
    echo "WARNING: DATABASE_URL is not set and .env is missing." | tee -a "$SUMMARY"
  fi
  run_check "prisma-migrate" npx prisma migrate deploy
fi
echo "Reports are in local-check-results/. Review logs for secrets before sharing."
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All selected checks passed."
