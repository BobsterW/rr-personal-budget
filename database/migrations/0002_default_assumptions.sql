INSERT INTO projection_assumptions (
  id, monthly_income_minor, monthly_expense_minor, monthly_savings_minor,
  annual_asset_growth_bps, annual_liability_interest_bps, horizon_months, updated_at
) VALUES ('default', 0, 0, 0, 400, 500, 60, datetime('now'))
ON CONFLICT(id) DO NOTHING;
