ALTER TABLE accounts ADD COLUMN annual_growth_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN payment_amount_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN payment_frequency TEXT NOT NULL DEFAULT 'none'
  CHECK (payment_frequency IN ('none','monthly','yearly'));
ALTER TABLE accounts ADD COLUMN annual_interest_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN annual_equity_gain_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN annual_dividend_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN annual_depreciation_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN projection_notes TEXT NOT NULL DEFAULT '';
