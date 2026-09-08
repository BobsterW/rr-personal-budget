-- V7.13 adds two independent authorization layers. Platform roles govern the
-- service; workspace roles govern one private budget. Existing financial rows
-- remain keyed to their original user_id, which becomes the workspace's
-- data_owner_user_id, so this migration does not rewrite financial history.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'standard'
  CHECK(platform_role IN ('standard','admin'));

-- Requested bootstrap administrator. Usernames remain case-insensitive through
-- username_normalized, so this safely targets BobbyW regardless of casing.
UPDATE users SET platform_role='admin',updated_at=datetime('now')
WHERE username_normalized='bobbyw';

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_owner_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(data_owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('login','active')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO workspaces(id,name,data_owner_user_id,created_at,updated_at)
SELECT 'workspace-' || id, username || '''s Budget', id, created_at, updated_at
FROM users;

INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at)
SELECT 'workspace-' || id,id,'owner',created_at,updated_at FROM users;

CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id,workspace_id);
CREATE INDEX idx_usage_events_created ON usage_events(created_at,user_id);
CREATE INDEX idx_audit_events_created ON audit_events(created_at DESC);
