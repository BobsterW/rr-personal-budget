-- V7.16 makes forecasts explainable: account calculations are specialized
-- projection rules, and budget snapshots follow the same archive-first
-- lifecycle as categories.
ALTER TABLE budget_snapshots ADD COLUMN active INTEGER NOT NULL DEFAULT 1
  CHECK (active IN (0,1));
ALTER TABLE budget_snapshots ADD COLUMN archived_at TEXT;

ALTER TABLE accounts ADD COLUMN account_model TEXT NOT NULL DEFAULT 'cash'
  CHECK (account_model IN ('cash','savings','investment','property','credit_card','mortgage','loan'));
UPDATE accounts SET account_model=CASE account_type
  WHEN 'savings' THEN 'savings'
  WHEN 'investment' THEN 'investment'
  WHEN 'credit_card' THEN 'credit_card'
  WHEN 'asset' THEN 'property'
  WHEN 'liability' THEN 'loan'
  ELSE 'cash' END;

ALTER TABLE website_preferences ADD COLUMN spacing TEXT NOT NULL DEFAULT 'comfortable';
ALTER TABLE website_preferences ADD COLUMN font_size TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE website_preferences ADD COLUMN heading_style TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE website_preferences ADD COLUMN card_corners TEXT NOT NULL DEFAULT 'rounded';
ALTER TABLE website_preferences ADD COLUMN card_shadow TEXT NOT NULL DEFAULT 'subtle';
ALTER TABLE website_preferences ADD COLUMN graph_text_size TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE website_preferences ADD COLUMN reduce_animation INTEGER NOT NULL DEFAULT 0;

PRAGMA foreign_keys=OFF;
CREATE TABLE projection_rules_v16 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 120),
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'income','expense','transfer','asset_growth','yield','debt_payment','debt_interest','extra_principal'
  )),
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly','yearly','once','weekly','biweekly')),
  start_date TEXT NOT NULL CHECK (start_date GLOB '????-??-??'),
  end_date TEXT CHECK (end_date IS NULL OR end_date GLOB '????-??-??'),
  from_account_id TEXT,
  to_account_id TEXT,
  linked_account_id TEXT,
  category_id TEXT,
  annual_rate_bps INTEGER NOT NULL DEFAULT 0,
  compounding_interval TEXT NOT NULL DEFAULT 'monthly'
    CHECK (compounding_interval IN ('monthly','yearly')),
  treatment TEXT NOT NULL DEFAULT 'deposit'
    CHECK (treatment IN ('deposit','reinvest','included_in_growth')),
  amortization_months INTEGER,
  term_months INTEGER,
  renewal_date TEXT,
  renewal_rate_bps INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,user_id),
  FOREIGN KEY(from_account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(to_account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(linked_account_id,user_id) REFERENCES accounts(id,user_id),
  FOREIGN KEY(category_id,user_id) REFERENCES categories(id,user_id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

INSERT INTO projection_rules_v16(
  id,user_id,description,rule_type,amount_minor,frequency,start_date,end_date,
  from_account_id,to_account_id,active,created_at,updated_at
)
SELECT id,user_id,description,rule_type,amount_minor,frequency,start_date,end_date,
       from_account_id,to_account_id,active,created_at,updated_at
FROM projection_rules;

DROP TABLE projection_rules;
ALTER TABLE projection_rules_v16 RENAME TO projection_rules;
CREATE INDEX idx_projection_rules_user_dates
  ON projection_rules(user_id,active,start_date,end_date);
CREATE INDEX idx_projection_rules_linked_account
  ON projection_rules(user_id,linked_account_id,active);
PRAGMA foreign_keys=ON;
