CREATE TABLE budget_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  effective_date TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, effective_date, revision)
);

CREATE TABLE budget_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES budget_snapshots(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  master_category_id TEXT,
  master_category_name TEXT NOT NULL,
  budget_scope TEXT NOT NULL CHECK (budget_scope IN ('personal','business')),
  monthly_budget_minor INTEGER NOT NULL CHECK (monthly_budget_minor >= 0),
  PRIMARY KEY(snapshot_id, category_id)
);

CREATE INDEX budget_snapshots_period
  ON budget_snapshots(user_id, effective_date, revision);
CREATE INDEX budget_snapshot_items_category
  ON budget_snapshot_items(category_id, snapshot_id);

-- V7.14 has only today's category values; it contains no earlier budget
-- history. Preserve those values as an explicit baseline rather than claiming
-- to know when they originally took effect.
INSERT INTO budget_snapshots(id,user_id,effective_date,name,revision,created_at)
SELECT 'budget-baseline-'||id,id,'0001-01-01',
       'Initial budget (earlier history unknown)',1,datetime('now')
FROM users;

INSERT INTO budget_snapshot_items(
  snapshot_id,category_id,category_name,kind,master_category_id,
  master_category_name,budget_scope,monthly_budget_minor
)
SELECT 'budget-baseline-'||c.user_id,c.id,c.name,c.kind,c.master_category_id,
       COALESCE(m.name,'Unassigned'),COALESCE(m.budget_scope,'personal'),
       COALESCE(c.monthly_budget_minor,0)
FROM categories c
LEFT JOIN master_categories m
  ON m.id=c.master_category_id AND m.user_id=c.user_id
WHERE c.active=1 AND c.kind IN ('expense','income');
