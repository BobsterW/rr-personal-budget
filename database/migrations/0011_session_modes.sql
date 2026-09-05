-- Short sessions require a per-tab key and expire after ten idle minutes.
-- The default keeps the schema safe while the new columns are added.
ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 1
  CHECK (persistent IN (0,1));
ALTER TABLE sessions ADD COLUMN page_key_hash TEXT;

-- Session semantics changed, so require one fresh sign-in after deployment.
DELETE FROM sessions;
