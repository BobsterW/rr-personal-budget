PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer','adjustment')),
  parent_name TEXT,
  monthly_budget_minor INTEGER CHECK (monthly_budget_minor IS NULL OR monthly_budget_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  account_type TEXT NOT NULL CHECK (account_type IN ('cash','chequing','savings','credit_card','investment','asset','liability')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
  duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  transaction_date TEXT NOT NULL CHECK (transaction_date GLOB '????-??-??'),
  category_id TEXT NOT NULL REFERENCES categories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  vendor_name TEXT NOT NULL CHECK (length(trim(vendor_name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('expense','income','transfer','adjustment')),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3),
  import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
  import_fingerprint TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE balance_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  snapshot_date TEXT NOT NULL CHECK (snapshot_date GLOB '????-??-??'),
  balance_minor INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, snapshot_date)
);

CREATE TABLE projection_assumptions (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  monthly_income_minor INTEGER NOT NULL DEFAULT 0,
  monthly_expense_minor INTEGER NOT NULL DEFAULT 0,
  monthly_savings_minor INTEGER NOT NULL DEFAULT 0,
  annual_asset_growth_bps INTEGER NOT NULL DEFAULT 0,
  annual_liability_interest_bps INTEGER NOT NULL DEFAULT 0,
  horizon_months INTEGER NOT NULL DEFAULT 60 CHECK (horizon_months BETWEEN 1 AND 600),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_category_date ON transactions(category_id, transaction_date DESC);
CREATE INDEX idx_transactions_account_date ON transactions(account_id, transaction_date DESC);
CREATE INDEX idx_snapshots_account_date ON balance_snapshots(account_id, snapshot_date DESC);
