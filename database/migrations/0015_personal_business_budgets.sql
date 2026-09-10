-- V7.14 adds optional personal/business reporting without changing existing
-- budgets. Existing workspaces remain combined and all existing records begin
-- in the personal group until an owner or editor intentionally reclassifies
-- their master categories and accounts.
ALTER TABLE workspaces ADD COLUMN separate_personal_business INTEGER NOT NULL DEFAULT 0
  CHECK(separate_personal_business IN (0,1));

ALTER TABLE master_categories ADD COLUMN budget_scope TEXT NOT NULL DEFAULT 'personal'
  CHECK(budget_scope IN ('personal','business'));

ALTER TABLE accounts ADD COLUMN budget_scope TEXT NOT NULL DEFAULT 'personal'
  CHECK(budget_scope IN ('personal','business'));

CREATE INDEX idx_master_categories_scope
  ON master_categories(user_id,budget_scope,active,name);
CREATE INDEX idx_accounts_scope
  ON accounts(user_id,budget_scope,active,name);
