CREATE TABLE budget_snapshots (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 effective_date TEXT NOT NULL,
 name TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1,
 items_json TEXT NOT NULL CHECK(json_valid(items_json)),
 created_at TEXT NOT NULL,
 UNIQUE(user_id,effective_date,revision)
);
CREATE INDEX budget_snapshots_period ON budget_snapshots(user_id,effective_date,revision);
-- Existing amounts are an explicit baseline, not recovered historical budgets.
INSERT INTO budget_snapshots(id,user_id,effective_date,name,items_json,created_at)
SELECT 'budget-baseline-'||u.id,u.id,'0001-01-01','Initial baseline (historical amounts unknown)',
 COALESCE((SELECT json_group_array(json_object('categoryId',c.id,'name',c.name,'kind',c.kind,'masterCategoryId',c.master_category_id,'masterName',COALESCE(m.name,'Unassigned'),'budgetScope',COALESCE(m.budget_scope,'personal'),'monthlyBudgetMinor',COALESCE(c.monthly_budget_minor,0))) FROM categories c LEFT JOIN master_categories m ON m.id=c.master_category_id AND m.user_id=c.user_id WHERE c.user_id=u.id AND c.active=1),'[]'),datetime('now')
FROM users u;
