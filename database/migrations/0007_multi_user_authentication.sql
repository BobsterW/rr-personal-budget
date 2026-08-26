PRAGMA defer_foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_token_expiry ON sessions(token_hash,expires_at);

CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,
  identifier_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_attempts_identifier_time ON auth_attempts(identifier_hash,created_at);
CREATE INDEX idx_auth_attempts_ip_time ON auth_attempts(ip_hash,created_at);

INSERT INTO users VALUES
  ('legacy-owner','Legacy V5 owner','legacy-v5-owner','$2b$12$disabledLegacyAccountCannotAuthenticate000000000000000000000',0,datetime('now'),datetime('now'));

ALTER TABLE transactions RENAME TO transactions_v5;
ALTER TABLE balance_snapshots RENAME TO balance_snapshots_v5;
ALTER TABLE future_purchases RENAME TO future_purchases_v5;
ALTER TABLE imports RENAME TO imports_v5;
ALTER TABLE category_rules RENAME TO category_rules_v5;
ALTER TABLE categories RENAME TO categories_v5;
ALTER TABLE master_categories RENAME TO master_categories_v5;
ALTER TABLE accounts RENAME TO accounts_v5;
ALTER TABLE projection_assumptions RENAME TO projection_assumptions_v5;

CREATE TABLE master_categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,name),
  UNIQUE(id,user_id)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer','adjustment')),
  parent_name TEXT,
  monthly_budget_minor INTEGER CHECK (monthly_budget_minor IS NULL OR monthly_budget_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  master_category_id TEXT,
  UNIQUE(user_id,name),
  UNIQUE(id,user_id),
  FOREIGN KEY(master_category_id,user_id) REFERENCES master_categories(id,user_id)
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  account_type TEXT NOT NULL CHECK (account_type IN ('cash','chequing','savings','credit_card','investment','asset','liability')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  annual_growth_bps INTEGER NOT NULL DEFAULT 0,
  payment_amount_minor INTEGER NOT NULL DEFAULT 0,
  payment_frequency TEXT NOT NULL DEFAULT 'none' CHECK (payment_frequency IN ('none','monthly','yearly')),
  annual_interest_bps INTEGER NOT NULL DEFAULT 0,
  annual_equity_gain_minor INTEGER NOT NULL DEFAULT 0,
  annual_dividend_minor INTEGER NOT NULL DEFAULT 0,
  annual_depreciation_bps INTEGER NOT NULL DEFAULT 0,
  projection_notes TEXT NOT NULL DEFAULT '',
  liquidity_class TEXT NOT NULL DEFAULT 'liquid' CHECK (liquidity_class IN ('fixed','liquid')),
  UNIQUE(user_id,name),
  UNIQUE(id,user_id)
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
  duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(id,user_id),
  FOREIGN KEY(account_id,user_id) REFERENCES accounts(id,user_id)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_date TEXT NOT NULL CHECK (transaction_date GLOB '????-??-??'),
  category_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL CHECK (length(trim(vendor_name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('expense','income','transfer','adjustment')),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3),
  import_id TEXT,
  import_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  balance_effect_minor INTEGER,
  UNIQUE(user_id,import_fingerprint),
  FOREIGN KEY(category_id,user_id) REFERENCES categories(id,user_id),
  FOREIGN KEY(account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(import_id,user_id) REFERENCES imports(id,user_id) ON DELETE SET NULL
);

CREATE TABLE balance_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL CHECK (snapshot_date GLOB '????-??-??'),
  balance_minor INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,account_id,snapshot_date),
  FOREIGN KEY(account_id,user_id) REFERENCES accounts(id,user_id)
);

CREATE TABLE category_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL COLLATE NOCASE,
  category_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,pattern),
  FOREIGN KEY(category_id,user_id) REFERENCES categories(id,user_id)
);

CREATE TABLE projection_assumptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  monthly_income_minor INTEGER NOT NULL DEFAULT 0,
  monthly_expense_minor INTEGER NOT NULL DEFAULT 0,
  monthly_savings_minor INTEGER NOT NULL DEFAULT 0,
  annual_asset_growth_bps INTEGER NOT NULL DEFAULT 0,
  annual_liability_interest_bps INTEGER NOT NULL DEFAULT 0,
  horizon_months INTEGER NOT NULL DEFAULT 60 CHECK (horizon_months BETWEEN 1 AND 600),
  updated_at TEXT NOT NULL
);

CREATE TABLE future_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  purchase_date TEXT NOT NULL CHECK (purchase_date GLOB '????-??-??'),
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id,user_id) REFERENCES accounts(id,user_id)
);

INSERT INTO master_categories SELECT id,'legacy-owner',name,active,created_at,updated_at FROM master_categories_v5;
INSERT INTO categories SELECT id,'legacy-owner',name,kind,parent_name,monthly_budget_minor,active,created_at,updated_at,master_category_id FROM categories_v5;
INSERT INTO accounts SELECT id,'legacy-owner',name,account_type,active,created_at,updated_at,annual_growth_bps,payment_amount_minor,payment_frequency,annual_interest_bps,annual_equity_gain_minor,annual_dividend_minor,annual_depreciation_bps,projection_notes,liquidity_class FROM accounts_v5;
INSERT INTO imports SELECT id,'legacy-owner',file_name,account_id,row_count,imported_count,duplicate_count,rejected_count,created_at FROM imports_v5;
INSERT INTO transactions SELECT id,'legacy-owner',transaction_date,category_id,account_id,vendor_name,description,amount_minor,transaction_type,currency,import_id,import_fingerprint,created_at,updated_at,balance_effect_minor FROM transactions_v5;
INSERT INTO balance_snapshots SELECT id,'legacy-owner',account_id,snapshot_date,balance_minor,note,created_at,updated_at FROM balance_snapshots_v5;
INSERT INTO category_rules SELECT id,'legacy-owner',pattern,category_id,priority,active,created_at,updated_at FROM category_rules_v5;
INSERT INTO projection_assumptions SELECT 'projection-legacy','legacy-owner',monthly_income_minor,monthly_expense_minor,monthly_savings_minor,annual_asset_growth_bps,annual_liability_interest_bps,horizon_months,updated_at FROM projection_assumptions_v5 LIMIT 1;
INSERT INTO future_purchases SELECT id,'legacy-owner',description,amount_minor,purchase_date,account_id,created_at,updated_at FROM future_purchases_v5;

DROP TABLE transactions_v5;
DROP TABLE balance_snapshots_v5;
DROP TABLE future_purchases_v5;
DROP TABLE imports_v5;
DROP TABLE category_rules_v5;
DROP TABLE categories_v5;
DROP TABLE master_categories_v5;
DROP TABLE accounts_v5;
DROP TABLE projection_assumptions_v5;

CREATE INDEX idx_transactions_user_date ON transactions(user_id,transaction_date DESC);
CREATE INDEX idx_transactions_user_category_date ON transactions(user_id,category_id,transaction_date DESC);
CREATE INDEX idx_transactions_user_account_effect ON transactions(user_id,account_id,transaction_date,balance_effect_minor);
CREATE INDEX idx_snapshots_user_account_date ON balance_snapshots(user_id,account_id,snapshot_date DESC);
CREATE INDEX idx_categories_user_master ON categories(user_id,master_category_id);
CREATE INDEX idx_category_rules_user_priority ON category_rules(user_id,active,priority,pattern);
CREATE INDEX idx_future_purchases_user_date ON future_purchases(user_id,purchase_date);

PRAGMA defer_foreign_keys = OFF;
