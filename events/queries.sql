-- Read-only queries used by cairn_log.py. Same text runs on ClickHouse and SQLite.
-- {cutoff} and {card} are filled in by cairn_log.py after validation (card matches ^[a-z0-9][a-z0-9_.-]{0,63}$,
-- cutoff is a timestamp the script itself formatted). No UPDATE or DELETE exists anywhere.

-- name: incident_groups
SELECT card_id, COUNT(*) AS n, COUNT(DISTINCT NULLIF(file, '')) AS files, COUNT(DISTINCT NULLIF(repo, '')) AS repos,
       COUNT(DISTINCT actor) AS actors, MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM cairn_events
WHERE ts >= '{cutoff}'
GROUP BY card_id
ORDER BY n DESC, card_id;

-- name: incident_evidence
SELECT ts, kind, card_id, repo, file, line, actor, tool, verdict, detail
FROM cairn_events
WHERE ts >= '{cutoff}'
ORDER BY card_id, ts;

-- name: spread
SELECT repo, file, MIN(ts) AS first_seen, MAX(ts) AS last_seen, COUNT(*) AS n
FROM cairn_events
WHERE card_id = '{card}' AND file != ''
GROUP BY repo, file
ORDER BY first_seen, repo, file;

-- name: ignored
SELECT e.ts, e.card_id, e.repo, e.file, e.line, e.actor, e.tool, e.detail
FROM cairn_events AS e
WHERE e.kind = 'agent_ignored_finding'
ORDER BY e.ts;
