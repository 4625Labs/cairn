-- Read-only queries for cairn_cards + cairn_events (ClickHouse). Run one at a time.

-- name: cards_latest
-- Latest version of every card (view-friendly, no raw_markdown).
SELECT card_id, version, status, class, severity, seed, created_at, source_sha256
FROM cairn_cards
ORDER BY card_id, version DESC
LIMIT 1 BY card_id;

-- name: cards_latest_argmax
-- Same idea with argMax (use when you need aggregates).
SELECT card_id, max(version) AS latest_version, argMax(status, version) AS latest_status,
       argMax(severity, version) AS latest_severity, argMax(created_at, version) AS latest_created_at
FROM cairn_cards
GROUP BY card_id
ORDER BY card_id;

-- name: cards_with_event_counts
-- Per card: findings, cousin_candidates, distinct files, last_seen, ignored warnings.
SELECT c.card_id, c.version, c.status, c.severity,
       countIf(e.kind = 'finding') AS findings,
       countIf(e.kind = 'cousin_candidate') AS cousin_candidates,
       uniqExactIf(e.file, e.file != '') AS files,
       if(count(e.kind) = 0, NULL, max(e.ts)) AS last_seen,
       countIf(e.kind = 'agent_ignored_finding') AS ignored
FROM (SELECT card_id, version, status, severity FROM cairn_cards ORDER BY card_id, version DESC LIMIT 1 BY card_id) AS c
LEFT JOIN cairn_events AS e ON e.card_id = c.card_id
GROUP BY c.card_id, c.version, c.status, c.severity
ORDER BY c.card_id;
