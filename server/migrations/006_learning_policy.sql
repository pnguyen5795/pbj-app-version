-- Each row remains one attributed observation. Equivalent observations share a
-- rule key; exclusions can remove one contribution without erasing the others.
ALTER TABLE pbj_memory ADD COLUMN IF NOT EXISTS learning jsonb;
ALTER TABLE pbj_memory ADD COLUMN IF NOT EXISTS rule_key text;
UPDATE pbj_memory SET rule_key=id WHERE rule_key IS NULL;
CREATE INDEX IF NOT EXISTS pbj_memory_rules ON pbj_memory(owner_id,rule_key);
CREATE UNIQUE INDEX IF NOT EXISTS pbj_memory_rule_events
  ON pbj_memory(owner_id,rule_key,(learning->>'eventID')) WHERE learning IS NOT NULL;
