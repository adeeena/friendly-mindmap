ALTER TABLE boards ADD COLUMN is_staged boolean NOT NULL DEFAULT false;
CREATE INDEX boards_staging_expiry_idx ON boards(updated_at) WHERE is_staged AND deleted_at IS NULL;
