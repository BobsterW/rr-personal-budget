-- V7.8 makes refunds a first-class transaction type. They retain a positive
-- account balance effect while expense reports subtract them from spending.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE transactions RENAME TO transactions_v77;

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_date TEXT NOT NULL CHECK (transaction_date GLOB '????-??-??'),
  category_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL CHECK (length(trim(vendor_name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('expense','refund','income','transfer','adjustment')),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3),
  import_id TEXT,
  import_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  balance_effect_minor INTEGER,
  transaction_direction TEXT NOT NULL DEFAULT 'debit' CHECK (transaction_direction IN ('debit','credit')),
  UNIQUE(user_id,import_fingerprint),
  FOREIGN KEY(category_id,user_id) REFERENCES categories(id,user_id),
  FOREIGN KEY(account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(import_id,user_id) REFERENCES imports(id,user_id) ON DELETE SET NULL
);

INSERT INTO transactions
SELECT id,user_id,transaction_date,category_id,account_id,vendor_name,description,
       amount_minor,transaction_type,currency,import_id,import_fingerprint,
       created_at,updated_at,balance_effect_minor,transaction_direction
FROM transactions_v77;

UPDATE transactions
SET transaction_type='refund'
WHERE transaction_type='expense' AND transaction_direction='credit';

DROP TABLE transactions_v77;

CREATE INDEX idx_transactions_user_date ON transactions(user_id,transaction_date DESC);
CREATE INDEX idx_transactions_user_category_date ON transactions(user_id,category_id,transaction_date DESC);
CREATE INDEX idx_transactions_user_account_effect ON transactions(user_id,account_id,transaction_date,balance_effect_minor);
CREATE INDEX idx_transactions_user_type_direction_date ON transactions(user_id,transaction_type,transaction_direction,transaction_date DESC);

PRAGMA defer_foreign_keys = OFF;
