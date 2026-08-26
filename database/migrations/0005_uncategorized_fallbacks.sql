INSERT OR IGNORE INTO categories
  (id,name,kind,parent_name,monthly_budget_minor,active,created_at,updated_at,master_category_id)
VALUES
  ('cat-uncategorized-expense','Uncategorized expense','expense',NULL,NULL,1,datetime('now'),datetime('now'),NULL),
  ('cat-uncategorized-income','Uncategorized income','income',NULL,NULL,1,datetime('now'),datetime('now'),NULL),
  ('cat-uncategorized-transfer','Uncategorized transfer','transfer',NULL,NULL,1,datetime('now'),datetime('now'),NULL),
  ('cat-uncategorized-adjustment','Uncategorized adjustment','adjustment',NULL,NULL,1,datetime('now'),datetime('now'),NULL);
