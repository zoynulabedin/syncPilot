#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
backup_path="backups/syncpilot-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U syncpilot -d syncpilot --format=custom > "$backup_path"
echo "Created $backup_path. Store an encrypted copy with the session encryption key in separate secure storage."
