-- Cairn behavior cards. Append-only: our code only ever runs INSERT and SELECT.
-- A changed card is a NEW row with version+1 (never UPDATE/DELETE). Latest = max(version) per card_id.
CREATE TABLE IF NOT EXISTS cairn_cards (
  card_id       LowCardinality(String),
  version       UInt32,
  created_at    DateTime64(3) DEFAULT now64(3),
  status        LowCardinality(String),
  class         LowCardinality(String),
  severity      String,
  seed          String,
  behavior      String,
  why           String,
  recognize     String,
  known_copies  String,
  safe_pattern  String,
  verification  String,
  source_sha256 FixedString(64),
  raw_markdown  String
) ENGINE = MergeTree ORDER BY (card_id, version);
