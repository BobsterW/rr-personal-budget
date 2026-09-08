-- One-time projection rules replace this older planning feature. The request
-- explicitly requires its historical rows to be removed as well as the table.
DROP TABLE future_purchases;

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invited_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','accepted','declined','cancelled','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(inviter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(invited_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_workspace_invitations_pending
ON workspace_invitations(workspace_id,invited_user_id)
WHERE status='pending';

CREATE INDEX idx_workspace_invitations_recipient
ON workspace_invitations(invited_user_id,status,expires_at);
