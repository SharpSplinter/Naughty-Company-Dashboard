-- Store validated endpoint-refresh configuration separately from job results.
-- This is configuration metadata only; credentials are never stored here.
ALTER TABLE admin_jobs ADD COLUMN job_payload_json TEXT;
