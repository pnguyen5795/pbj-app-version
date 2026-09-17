CREATE TABLE IF NOT EXISTS pbj_speech_chunks (
 id text PRIMARY KEY, owner_id text NOT NULL, asset_id text NOT NULL,
 chunk_index integer NOT NULL, core_start double precision NOT NULL,
 core_end double precision NOT NULL, window_start double precision NOT NULL,
 window_end double precision NOT NULL, status text NOT NULL DEFAULT 'reserved',
 full_response jsonb, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,asset_id,chunk_index),
 FOREIGN KEY(owner_id,asset_id) REFERENCES pbj_assets(owner_id,id)
);
