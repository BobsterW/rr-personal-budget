-- V7.5 records whether money left or entered the selected account. Existing
-- expenses were purchases (debits), while existing income was money in
-- (credits). The positive stored amount remains easy to validate and audit.
ALTER TABLE transactions
ADD COLUMN transaction_direction TEXT NOT NULL DEFAULT 'debit'
CHECK (transaction_direction IN ('debit','credit'));

UPDATE transactions
SET transaction_direction = 'credit'
WHERE transaction_type = 'income';

CREATE INDEX idx_transactions_user_type_direction_date
ON transactions(user_id,transaction_type,transaction_direction,transaction_date DESC);
