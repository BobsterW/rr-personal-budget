-- V7.6 replaces the synthetic "Projected cash flow" balance with recurring
-- rules that move money into, out of, or between real user-owned accounts.
CREATE TABLE projection_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 120),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('income','expense','transfer')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly','yearly','once')),
  start_date TEXT NOT NULL CHECK (start_date GLOB '????-??-??'),
  end_date TEXT CHECK (end_date IS NULL OR end_date GLOB '????-??-??'),
  from_account_id TEXT,
  to_account_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,user_id),
  FOREIGN KEY(from_account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(to_account_id,user_id) REFERENCES accounts(id,user_id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (
    (rule_type='income' AND from_account_id IS NULL AND to_account_id IS NOT NULL) OR
    (rule_type='expense' AND from_account_id IS NOT NULL AND to_account_id IS NULL) OR
    (rule_type='transfer' AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id)
  )
);

CREATE INDEX idx_projection_rules_user_dates
  ON projection_rules(user_id,active,start_date,end_date);

