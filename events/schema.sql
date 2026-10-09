-- Cairn event log. ONE table, append-only: our code only ever runs INSERT and SELECT.
-- ClickHouse flavour. (cairn_log.py creates the SQLite twin with the same columns.)
CREATE TABLE IF NOT EXISTS cairn_events (
  ts      DateTime64(3) DEFAULT now64(3),
  kind    LowCardinality(String),   -- finding | cousin_candidate | human_confirm | agent_write | agent_ignored_finding | pr_gate | device_approval | reintroduced
  card_id LowCardinality(String),
  repo    String,
  file    String,
  line    UInt32,
  actor   String,
  tool    String,
  detail  String,
  verdict LowCardinality(String)
) ENGINE = MergeTree ORDER BY (card_id, ts);
