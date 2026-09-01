-- Invented development data only. Never add real financial data here.
-- Local login: demo / DemoUser1!
INSERT OR IGNORE INTO users (id,username,username_normalized,password_hash,created_at,updated_at) VALUES
('user-demo','demo','demo','$2b$12$FCEI1c5.jWw2buLM4reLvOdsWVjouZaKF./Tdn8wOUS1mCDF.dW4C',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO projection_assumptions (id,user_id,annual_asset_growth_bps,annual_liability_interest_bps,horizon_months,updated_at) VALUES
('projection-demo','user-demo',400,500,60,datetime('now'));

INSERT OR IGNORE INTO categories (id,user_id,name,kind,parent_name,monthly_budget_minor,active,created_at,updated_at) VALUES
('cat-groceries','user-demo','Groceries','expense','Food',50000,1,datetime('now'),datetime('now')),
('cat-eating-out','user-demo','Eating Out','expense','Food',10000,1,datetime('now'),datetime('now')),
('cat-gas','user-demo','Gas','expense','Car',20000,1,datetime('now'),datetime('now')),
('cat-home','user-demo','Home Cost','expense','Household',4000,1,datetime('now'),datetime('now')),
('cat-work','user-demo','Work Income','income','Income',NULL,1,datetime('now'),datetime('now')),
('cat-transfer','user-demo','Transfer','transfer',NULL,NULL,1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO accounts (id,user_id,name,account_type,active,created_at,updated_at,liquidity_class) VALUES
('acct-demo-card','user-demo','Demo Mastercard','credit_card',1,datetime('now'),datetime('now'),'liquid'),
('acct-demo-chequing','user-demo','Demo Chequing','chequing',1,datetime('now'),datetime('now'),'liquid'),
('acct-demo-savings','user-demo','Demo Savings','savings',1,datetime('now'),datetime('now'),'liquid'),
('acct-demo-investment','user-demo','Demo Investment','investment',1,datetime('now'),datetime('now'),'liquid'),
('acct-demo-loan','user-demo','Demo Student Loan','liability',1,datetime('now'),datetime('now'),'fixed');

INSERT OR IGNORE INTO transactions (id,user_id,transaction_date,category_id,account_id,vendor_name,description,amount_minor,transaction_type,transaction_direction,currency,import_id,import_fingerprint,created_at,updated_at,balance_effect_minor) VALUES
('txn-demo-1','user-demo','2026-06-03','cat-groceries','acct-demo-card','Sample Grocer','Invented seed transaction',8425,'expense','debit','CAD',NULL,NULL,datetime('now'),datetime('now'),-8425),
('txn-demo-2','user-demo','2026-06-14','cat-gas','acct-demo-card','Sample Fuel','Invented seed transaction',6270,'expense','debit','CAD',NULL,NULL,datetime('now'),datetime('now'),-6270),
('txn-demo-3','user-demo','2026-06-15','cat-work','acct-demo-chequing','Sample Employer','Invented seed transaction',250000,'income','credit','CAD',NULL,NULL,datetime('now'),datetime('now'),250000);

INSERT OR IGNORE INTO balance_snapshots (id,user_id,account_id,snapshot_date,balance_minor,note,created_at,updated_at) VALUES
('bal-demo-1','user-demo','acct-demo-savings','2026-06-30',1500000,'Invented seed balance',datetime('now'),datetime('now')),
('bal-demo-2','user-demo','acct-demo-investment','2026-06-30',4200000,'Invented seed balance',datetime('now'),datetime('now')),
('bal-demo-3','user-demo','acct-demo-loan','2026-06-30',-2200000,'Liabilities are stored as negative balances',datetime('now'),datetime('now'));
