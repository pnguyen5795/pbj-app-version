ALTER TABLE pbj_projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE pbj_projects ADD COLUMN IF NOT EXISTS duration_goal jsonb;
ALTER TABLE pbj_projects ADD COLUMN IF NOT EXISTS required_moments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE pbj_projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pbj_projects ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE pbj_revisions ADD COLUMN IF NOT EXISTS feedback text NOT NULL DEFAULT '';
ALTER TABLE pbj_revisions ADD COLUMN IF NOT EXISTS accepted boolean NOT NULL DEFAULT true;
ALTER TABLE pbj_jobs ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'Waiting';
ALTER TABLE pbj_jobs ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE pbj_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS pbj_uploads (
 id text PRIMARY KEY, owner_id text NOT NULL, sha256 text NOT NULL,
 file_name text NOT NULL, byte_count bigint NOT NULL CHECK(byte_count>0),
 received_bytes bigint NOT NULL DEFAULT 0, asset_id text,
 status text NOT NULL DEFAULT 'receiving', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,sha256), FOREIGN KEY(owner_id,asset_id) REFERENCES pbj_assets(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_provider_calls (
 id text PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL, input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'reserved', full_response jsonb, usage jsonb,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_feedback (
 id text PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, revision_id text NOT NULL,
 text text NOT NULL, reusable boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,project_id,revision_id) REFERENCES pbj_revisions(owner_id,project_id,id)
);
