/* Shared domain contracts. Monetary values are integer cents and rates are
 * basis points, avoiding floating-point rounding in storage and calculations. */
export type TransactionType = "expense" | "income" | "transfer" | "adjustment";
export type AccountType =
  | "cash"
  | "chequing"
  | "savings"
  | "credit_card"
  | "investment"
  | "asset"
  | "liability";

export interface TransactionInput {
  transactionDate: string;
  categoryId: string;
  accountId: string;
  vendorName: string;
  description?: string;
  amountMinor: number;
  transactionType: TransactionType;
  currency?: string;
  importFingerprint?: string;
  balanceEffectMinor?: number | null;
}

export interface ProjectionAssumptions {
  monthlyIncomeMinor: number;
  monthlyExpenseMinor: number;
  monthlySavingsMinor: number;
  annualAssetGrowthBps: number;
  annualLiabilityInterestBps: number;
  horizonMonths: number;
}

export type PaymentFrequency = "none" | "monthly" | "yearly";
export type LiquidityClass = "fixed" | "liquid";

export interface AccountProjectionInput {
  id: string;
  name: string;
  accountType: AccountType;
  liquidityClass: LiquidityClass;
  balanceMinor: number;
  annualGrowthBps: number;
  paymentAmountMinor: number;
  paymentFrequency: PaymentFrequency;
  annualInterestBps: number;
  annualEquityGainMinor: number;
  annualDividendMinor: number;
  annualDepreciationBps: number;
}

export interface ValidationIssue {
  field: string;
  message: string;
}
