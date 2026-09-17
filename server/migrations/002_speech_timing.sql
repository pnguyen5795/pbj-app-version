-- Optional, separately cached word timing. Completed baseline video analysis
-- is never replaced or rescanned to obtain these audio-only results.
CREATE TABLE IF NOT EXISTS pbj_speech_timing (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','submitting','complete','unresolved','needs_review')),
  intent jsonb NOT NULL,
  full_response jsonb,
  evidence jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,asset_id),
  FOREIGN KEY(owner_id,asset_id) REFERENCES pbj_assets(owner_id,id),
  CHECK (status <> 'complete' OR (full_response IS NOT NULL AND evidence IS NOT NULL))
);
