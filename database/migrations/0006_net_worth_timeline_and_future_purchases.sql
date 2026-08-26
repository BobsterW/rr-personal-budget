ALTER TABLE transactions ADD COLUMN balance_effect_minor INTEGER;

UPDATE transactions
SET balance_effect_minor = CASE
  WHEN transaction_type='expense' THEN -amount_minor
  WHEN transaction_type='income' THEN amount_minor
  WHEN transaction_type='adjustment' THEN 0
  ELSE NULL
END;

CREATE TABLE future_purchases (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  purchase_date TEXT NOT NULL CHECK (purchase_date GLOB '????-??-??'),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_future_purchases_date ON future_purchases(purchase_date);
CREATE INDEX idx_transactions_account_effect_date ON transactions(account_id,transaction_date,balance_effect_minor);
