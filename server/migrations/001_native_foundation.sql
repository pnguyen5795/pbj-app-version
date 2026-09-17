CREATE TABLE IF NOT EXISTS pbj_assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[a-f0-9]{64}$'),
  original_name text NOT NULL,
  storage_key text NOT NULL,
  duration_ticks bigint NOT NULL CHECK (duration_ticks > 0),
  media_start_ticks bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, original_sha256), UNIQUE(owner_id, id)
);

-- One baseline per owned original, independent of project/model/schema/brief.
-- Explicit reanalysis will be a separate authorized version, never an upsert.
CREATE TABLE IF NOT EXISTS pbj_analysis (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','uploading','uploaded','submitting','pending','complete','unresolved','failed','needs_review')),
  idempotency_key text NOT NULL UNIQUE,
  provider_asset_id text,
  provider_task_id text,
  intent jsonb NOT NULL,
  full_response jsonb,
  evidence jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, asset_id),
  FOREIGN KEY(owner_id,asset_id) REFERENCES pbj_assets(owner_id,id),
  CHECK (status <> 'complete' OR (full_response IS NOT NULL AND evidence IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS pbj_projects (
  id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, brief text NOT NULL,
  current_revision_id text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_project_inputs (
  owner_id text NOT NULL, project_id text NOT NULL, asset_id text NOT NULL,
  PRIMARY KEY(project_id,asset_id),
  FOREIGN KEY(owner_id,project_id) REFERENCES pbj_projects(owner_id,id),
  FOREIGN KEY(owner_id,asset_id) REFERENCES pbj_assets(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_revisions (
  id text PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, parent_id text,
  origin text NOT NULL CHECK (origin IN ('initial','ai_revision','approved','manual','restored')),
  timeline jsonb NOT NULL, evidence_versions jsonb NOT NULL, summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,project_id) REFERENCES pbj_projects(owner_id,id), UNIQUE(owner_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_teaching_groups (
  id text PRIMARY KEY, owner_id text NOT NULL, attribution text NOT NULL, notes text NOT NULL,
  final_asset_id text NOT NULL, raw_asset_ids jsonb NOT NULL DEFAULT '[]', enabled boolean NOT NULL DEFAULT true,
  FOREIGN KEY(owner_id,final_asset_id) REFERENCES pbj_assets(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_memory (
  id text PRIMARY KEY, owner_id text NOT NULL, version integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('reference','personal_lesson')),
  context text NOT NULL, statement text NOT NULL,
  strength text NOT NULL CHECK (strength IN ('weak','moderate','strong')),
  attribution text NOT NULL, project_scope text,
  provenance jsonb NOT NULL, root_evidence_ids jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_excluded_evidence (
  owner_id text NOT NULL, evidence_id text NOT NULL, PRIMARY KEY(owner_id,evidence_id)
);
CREATE TABLE IF NOT EXISTS pbj_exports (
  id text PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, revision_id text NOT NULL,
  artifact_sha256 text NOT NULL, verification jsonb NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending',
  UNIQUE(owner_id,revision_id),
  FOREIGN KEY(owner_id,project_id,revision_id) REFERENCES pbj_revisions(owner_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS pbj_jobs (
  id text PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL,
  dedupe_key text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','attention')),
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  lease_token text, last_error text,
  UNIQUE(owner_id,kind,dedupe_key)
);
CREATE INDEX IF NOT EXISTS pbj_jobs_ready ON pbj_jobs(status,available_at);
