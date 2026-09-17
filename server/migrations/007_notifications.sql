CREATE TABLE IF NOT EXISTS pbj_notification_devices (
 id text PRIMARY KEY, owner_id text NOT NULL, token text,
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pbj_notification_token ON pbj_notification_devices(token,environment) WHERE token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pbj_job_owner_identity ON pbj_jobs(owner_id,id);
CREATE TABLE IF NOT EXISTS pbj_notification_watches (
 owner_id text NOT NULL, device_id text NOT NULL, job_id text NOT NULL,
 PRIMARY KEY(owner_id,device_id,job_id),
 FOREIGN KEY(owner_id,device_id) REFERENCES pbj_notification_devices(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,job_id) REFERENCES pbj_jobs(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pbj_notifications (
 id text PRIMARY KEY, sequence bigserial UNIQUE, owner_id text NOT NULL,
 device_id text NOT NULL, job_id text NOT NULL, event_key text NOT NULL, event jsonb NOT NULL,
 delivery_status text NOT NULL CHECK(delivery_status IN ('local_only','pending','sending','sent','failed','suppressed')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token text, lease_until timestamptz, last_error text, read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,device_id,event_key),
 FOREIGN KEY(owner_id,device_id,job_id) REFERENCES pbj_notification_watches(owner_id,device_id,job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pbj_notifications_delivery ON pbj_notifications(delivery_status,available_at);
