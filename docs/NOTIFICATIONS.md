# Operational alert delivery

The worker evaluates all workspace jobs, rather than the visible page. Failed/dead-letter jobs use the owner's threshold; held jobs and overdue pending/retry jobs alert from one. A condition produces one opening delivery and one resolution delivery. Repeated unchanged evaluations are quiet.

External delivery is off by default. The deployment operator configures `ALERT_WEBHOOK_URL`, an exact comma-separated `ALERT_WEBHOOK_HOSTS` allowlist, and optionally `ALERT_WEBHOOK_TOKEN` in secret storage. A workspace owner must additionally enable external delivery in Settings; the in-app notification switch must also be enabled. No destination is currently configured or contacted by this implementation work.

The payload contains `deliveryId`, `workspaceId`, `kind` (`FAILED`, `HELD`, `LAGGING`), `state` (`OPEN`, `RESOLVED`), `value`, and `text`. It excludes shop names, product values, raw events and credentials. Receivers should return 2xx after durably accepting the event and deduplicate its `Idempotency-Key` header. Configure a receiver that accepts this JSON contract. No direct email/Slack SDK integration is claimed.

HTTPS is required. Credentials in URL authority, nonstandard ports, unlisted hosts and private/reserved DNS addresses are rejected. The vetted IP is pinned into the HTTPS request with certificate verification against the original hostname. Redirects are never followed. Response bodies are discarded. Authorization tokens and endpoint URLs never enter delivery records.

PostgreSQL stores the outbox, transition deduplication and leased delivery attempts. Workers recheck consent and workspace state before sending. Network errors, 408, 429 and 5xx retry with bounded backoff; other non-2xx responses fail. A delivery has at most five attempts and retains the same ID after a timeout. External delivery is at least once; a receiver without idempotency support can receive duplicates after an uncertain response. Opt-out prevents future sends; it cannot recall a request already accepted by a receiver.

Settings shows the last 10 attempts. Owner-opted retention removes eligible old delivered/cancelled records, preserving failures for review. Workspace erasure cascades outbox and alert-state records.

A stopped worker cannot alert about its own absence, including a worker that refused to start because the PostgreSQL session time zone is not UTC (`DATABASE_TIME_ZONE_NOT_UTC`). Delivery leases and retry timing depend on that zone; in a test run against a non-UTC database an alert was delivered twice. Configure independent Coolify/service monitoring for worker heartbeat, HTTPS availability, database health and backup age before production. Real receiver delivery and external monitoring acceptance remain deployment tasks.
