/*
 * D1 REPOSITORY
 * Route handlers validate HTTP input; this class owns SQL. Every financial
 * query is scoped by `this.userId`, while composite foreign keys provide a
 * second database-level barrier against cross-user relationships.
 */
import type { TransactionInput } from "./types";

// Stored amounts stay positive. These static SQL expressions apply the
// direction when calculating spending and income; no user input enters them.
const EXPENSE_EFFECT_SQL =
  "CASE WHEN t.transaction_direction='credit' THEN -t.amount_minor ELSE t.amount_minor END";
const INCOME_EFFECT_SQL =
  "CASE WHEN t.transaction_direction='debit' THEN -t.amount_minor ELSE t.amount_minor END";

const NOISE_WORDS = new Set([
  "purchase",
  "retail",
  "visa",
  "debit",
  "point",
  "sale",
  "interac",
  "internet",
  "banking",
  "transaction",
  "limited",
  "ltd",
  "inc",
  "corp",
  "store",
  "payment",
  "pos",
]);
// Remove payment-network noise and reference numbers before matching vendors.
function merchantTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/\b\d{4,}\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(
          (token) =>
            token.length > 2 && !/^\d+$/.test(token) && !NOISE_WORDS.has(token),
        ),
    ),
  ];
}
function merchantKey(value: string): string {
  return merchantTokens(value).join(" ");
}
function tokenSimilarity(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right),
    intersection = left.filter((token) => rightSet.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

export class BudgetRepository {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {}

  // A signed effect lets historical net worth move forward/back from snapshots.
  private balanceEffect(input: TransactionInput): number | null {
    if (input.balanceEffectMinor !== undefined) return input.balanceEffectMinor;
    return input.transactionDirection === "credit"
      ? input.amountMinor
      : -input.amountMinor;
  }

  async listLookup(table: "categories" | "accounts") {
    return (
      await this.db
        .prepare(
          `SELECT * FROM ${table} WHERE user_id=? ORDER BY active DESC, name`,
        )
        .bind(this.userId)
        .all()
    ).results;
  }

  async createLookup(
    table: "categories" | "accounts",
    input: Record<string, unknown>,
  ) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    if (table === "categories")
      await this.db
        .prepare(
          "INSERT INTO categories (id,user_id,name,kind,parent_name,monthly_budget_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          this.userId,
          input.name,
          input.kind,
          input.parentName ?? null,
          input.monthlyBudgetMinor ?? null,
          now,
          now,
        )
        .run();
    else
      await this.db
        .prepare(
          "INSERT INTO accounts (id,user_id,name,account_type,liquidity_class,annual_growth_bps,payment_amount_minor,payment_frequency,annual_interest_bps,annual_equity_gain_minor,annual_dividend_minor,annual_depreciation_bps,projection_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          this.userId,
          input.name,
          input.accountType,
          input.liquidityClass ?? "liquid",
          input.annualGrowthBps ?? 0,
          input.paymentAmountMinor ?? 0,
          input.paymentFrequency ?? "none",
          input.annualInterestBps ?? 0,
          input.annualEquityGainMinor ?? 0,
          input.annualDividendMinor ?? 0,
          input.annualDepreciationBps ?? 0,
          input.projectionNotes ?? "",
          now,
          now,
        )
        .run();
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id=?`)
      .bind(id, this.userId)
      .first();
  }

  async archiveLookup(table: "categories" | "accounts", id: string) {
    const result = await this.db
      .prepare(
        `UPDATE ${table} SET active=0, updated_at=? WHERE id=? AND user_id=?`,
      )
      .bind(new Date().toISOString(), id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  async listMasterCategories() {
    return (
      await this.db
        .prepare(
          "SELECT * FROM master_categories WHERE user_id=? ORDER BY active DESC,name",
        )
        .bind(this.userId)
        .all()
    ).results;
  }

  async createMasterCategory(name: string) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO master_categories (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(id, this.userId, name, now, now)
      .run();
    return this.db
      .prepare("SELECT * FROM master_categories WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .first();
  }

  async archiveMasterCategory(id: string) {
    const result = await this.db
      .prepare(
        "UPDATE master_categories SET active=0,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(new Date().toISOString(), id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  async updateCategoryMaster(id: string, masterCategoryId: string | null) {
    const result = await this.db
      .prepare(
        "UPDATE categories SET master_category_id=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(masterCategoryId, new Date().toISOString(), id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  async listCategoryRules() {
    return (
      await this.db
        .prepare(
          "SELECT r.*,c.name category_name FROM category_rules r JOIN categories c ON c.id=r.category_id AND c.user_id=r.user_id WHERE r.user_id=? ORDER BY r.active DESC,r.priority,r.pattern",
        )
        .bind(this.userId)
        .all()
    ).results;
  }

  async createCategoryRule(
    pattern: string,
    categoryId: string,
    priority: number,
  ) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO category_rules (id,user_id,pattern,category_id,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(id, this.userId, pattern, categoryId, priority, now, now)
      .run();
    return this.db
      .prepare(
        "SELECT r.*,c.name category_name FROM category_rules r JOIN categories c ON c.id=r.category_id AND c.user_id=r.user_id WHERE r.id=? AND r.user_id=?",
      )
      .bind(id, this.userId)
      .first();
  }

  async archiveCategoryRule(id: string) {
    const result = await this.db
      .prepare(
        "UPDATE category_rules SET active=0,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(new Date().toISOString(), id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  // Match priority: user rule, exact history, fuzzy history, then keywords.
  async suggestCategories(descriptions: string[]) {
    const rules = await this.db
      .prepare(
        "SELECT pattern,category_id,priority FROM category_rules WHERE active=1 AND user_id=? ORDER BY priority, length(pattern) DESC",
      )
      .bind(this.userId)
      .all<{ pattern: string; category_id: string; priority: number }>();
    const history = await this.db
      .prepare(
        "SELECT lower(trim(vendor_name)) vendor,category_id,COUNT(*) uses FROM transactions WHERE user_id=? GROUP BY lower(trim(vendor_name)),category_id ORDER BY uses DESC",
      )
      .bind(this.userId)
      .all<{ vendor: string; category_id: string; uses: number }>();
    const learned = new Map<
      string,
      { categoryId: string; uses: number; tokens: string[] }
    >();
    for (const row of history.results) {
      const key = merchantKey(row.vendor);
      const existing = learned.get(key);
      if (key && (!existing || row.uses > existing.uses))
        learned.set(key, {
          categoryId: row.category_id,
          uses: row.uses,
          tokens: merchantTokens(row.vendor),
        });
    }
    const categories = await this.db
      .prepare("SELECT id,name FROM categories WHERE active=1 AND user_id=?")
      .bind(this.userId)
      .all<{ id: string; name: string }>();
    const heuristicGroups: Array<{ words: string[]; categoryWords: string[] }> =
      [
        {
          words: [
            "costco",
            "walmart",
            "sobeys",
            "safeway",
            "grocery",
            "superstore",
            "save on foods",
            "freshco",
          ],
          categoryWords: ["grocery", "food"],
        },
        {
          words: ["shell", "esso", "petro", "fuel", "gas station"],
          categoryWords: ["gas", "fuel"],
        },
        {
          words: [
            "restaurant",
            "mcdonald",
            "tim horton",
            "starbucks",
            "uber eats",
            "doordash",
            "subway",
            "a&w",
          ],
          categoryWords: ["eating", "restaurant", "dining"],
        },
        {
          words: ["home depot", "rona", "utility", "epcor", "enmax"],
          categoryWords: ["home", "housing", "utility"],
        },
        {
          words: ["payment received", "thank you", "payment -"],
          categoryWords: ["transfer", "payment"],
        },
        {
          words: ["payroll", "salary", "employer"],
          categoryWords: ["income", "work"],
        },
        {
          words: ["netflix", "spotify", "apple.com/bill", "subscription"],
          categoryWords: ["subscription", "entertainment"],
        },
        {
          words: ["pharmacy", "shoppers drug", "medical", "dental"],
          categoryWords: ["health", "medical", "pharmacy"],
        },
        { words: ["insurance"], categoryWords: ["insurance"] },
      ];
    return descriptions.map((description) => {
      const normalized = description.trim().toLowerCase();
      const key = merchantKey(description),
        tokens = merchantTokens(description);
      const rule = rules.results.find(
        (item) =>
          normalized.includes(item.pattern.toLowerCase()) ||
          (merchantKey(item.pattern).length > 0 &&
            key.includes(merchantKey(item.pattern))),
      );
      const group = heuristicGroups.find((item) =>
        item.words.some((word) => normalized.includes(word)),
      );
      const heuristic = group
        ? categories.results.find((category) =>
            group.categoryWords.some((word) =>
              category.name.toLowerCase().includes(word),
            ),
          )
        : undefined;
      const exact = learned.get(key);
      let fuzzy: { categoryId: string; score: number } | undefined;
      if (!exact && tokens.length)
        for (const candidate of learned.values()) {
          const score = tokenSimilarity(tokens, candidate.tokens);
          if (score >= 0.55 && (!fuzzy || score > fuzzy.score))
            fuzzy = { categoryId: candidate.categoryId, score };
        }
      const categoryId =
        rule?.category_id ??
        exact?.categoryId ??
        fuzzy?.categoryId ??
        heuristic?.id ??
        null;
      const source = rule
        ? "rule"
        : exact
          ? "merchant-history"
          : fuzzy
            ? "similar-merchant"
            : heuristic
              ? "keyword"
              : null;
      return {
        description,
        categoryId,
        source,
        confidence: rule
          ? 1
          : exact
            ? Math.min(0.99, 0.85 + exact.uses / 100)
            : fuzzy
              ? Number(fuzzy.score.toFixed(2))
              : heuristic
                ? 0.72
                : 0,
      };
    });
  }

  async updateAccount(id: string, input: Record<string, unknown>) {
    const result = await this.db
      .prepare(
        "UPDATE accounts SET name=?,account_type=?,liquidity_class=?,annual_growth_bps=?,payment_amount_minor=?,payment_frequency=?,annual_interest_bps=?,annual_equity_gain_minor=?,annual_dividend_minor=?,annual_depreciation_bps=?,projection_notes=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(
        input.name,
        input.accountType,
        input.liquidityClass,
        input.annualGrowthBps,
        input.paymentAmountMinor,
        input.paymentFrequency,
        input.annualInterestBps,
        input.annualEquityGainMinor,
        input.annualDividendMinor,
        input.annualDepreciationBps,
        input.projectionNotes,
        new Date().toISOString(),
        id,
        this.userId,
      )
      .run();
    if (!result.meta.changes) return null;
    return this.db
      .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .first();
  }

  async timelineData() {
    const [accounts, snapshots, effects, purchases, projectionRules] =
      await Promise.all([
        this.db
          .prepare(
            "SELECT * FROM accounts WHERE active=1 AND user_id=? ORDER BY name",
          )
          .bind(this.userId)
          .all(),
        this.db
          .prepare(
            "SELECT account_id,snapshot_date,balance_minor FROM balance_snapshots WHERE user_id=? ORDER BY snapshot_date",
          )
          .bind(this.userId)
          .all(),
        this.db
          .prepare(
            "SELECT account_id,transaction_date,balance_effect_minor FROM transactions WHERE balance_effect_minor IS NOT NULL AND user_id=? ORDER BY transaction_date",
          )
          .bind(this.userId)
          .all(),
        this.db
          .prepare(
            "SELECT * FROM future_purchases WHERE user_id=? ORDER BY purchase_date,description",
          )
          .bind(this.userId)
          .all(),
        this.db
          .prepare(
            "SELECT * FROM projection_rules WHERE user_id=? AND active=1 ORDER BY start_date,description",
          )
          .bind(this.userId)
          .all(),
      ]);
    return {
      accounts: accounts.results,
      snapshots: snapshots.results,
      effects: effects.results,
      purchases: purchases.results,
      projectionRules: projectionRules.results,
    };
  }

  async listProjectionRules() {
    return (
      await this.db
        .prepare(
          "SELECT r.*,fa.name from_account_name,ta.name to_account_name FROM projection_rules r LEFT JOIN accounts fa ON fa.id=r.from_account_id AND fa.user_id=r.user_id LEFT JOIN accounts ta ON ta.id=r.to_account_id AND ta.user_id=r.user_id WHERE r.user_id=? AND r.active=1 ORDER BY r.start_date,r.description",
        )
        .bind(this.userId)
        .all()
    ).results;
  }

  async createProjectionRule(input: {
    description: string;
    ruleType: "income" | "expense" | "transfer";
    amountMinor: number;
    frequency: "monthly" | "yearly" | "once";
    startDate: string;
    endDate: string | null;
    fromAccountId: string | null;
    toAccountId: string | null;
  }) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO projection_rules (id,user_id,description,rule_type,amount_minor,frequency,start_date,end_date,from_account_id,to_account_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        this.userId,
        input.description,
        input.ruleType,
        input.amountMinor,
        input.frequency,
        input.startDate,
        input.endDate,
        input.fromAccountId,
        input.toAccountId,
        now,
        now,
      )
      .run();
    return this.db
      .prepare("SELECT * FROM projection_rules WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .first();
  }

  async deleteProjectionRule(id: string) {
    const result = await this.db
      .prepare(
        "UPDATE projection_rules SET active=0,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(new Date().toISOString(), id, this.userId)
      .run();
    return Number(result.meta.changes ?? 0) > 0;
  }

  async listFuturePurchases() {
    return (
      await this.db
        .prepare(
          "SELECT p.*,a.name account_name FROM future_purchases p JOIN accounts a ON a.id=p.account_id AND a.user_id=p.user_id WHERE p.user_id=? ORDER BY purchase_date,description",
        )
        .bind(this.userId)
        .all()
    ).results;
  }

  async createFuturePurchase(
    description: string,
    amountMinor: number,
    purchaseDate: string,
    accountId: string,
  ) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO future_purchases (id,user_id,description,amount_minor,purchase_date,account_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        this.userId,
        description,
        amountMinor,
        purchaseDate,
        accountId,
        now,
        now,
      )
      .run();
    return this.db
      .prepare(
        "SELECT p.*,a.name account_name FROM future_purchases p JOIN accounts a ON a.id=p.account_id AND a.user_id=p.user_id WHERE p.id=? AND p.user_id=?",
      )
      .bind(id, this.userId)
      .first();
  }

  async deleteFuturePurchase(id: string) {
    const result = await this.db
      .prepare("DELETE FROM future_purchases WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  // Filter values are bound parameters. Sort SQL comes only from an allowlist.
  async listTransactions(params: URLSearchParams) {
    const clauses: string[] = ["t.user_id=?"];
    const bindings: unknown[] = [this.userId];
    const mappings: Array<[string, string]> = [
      ["month", "substr(t.transaction_date,1,7)"],
      ["startDate", "t.transaction_date >="],
      ["endDate", "t.transaction_date <="],
      ["categoryId", "t.category_id"],
      ["accountId", "t.account_id"],
      ["type", "t.transaction_type"],
    ];
    for (const [key, column] of mappings)
      if (params.get(key)) {
        clauses.push(
          column.endsWith(">=") || column.endsWith("<=")
            ? `${column}?`
            : `${column}=?`,
        );
        bindings.push(params.get(key));
      }
    if (params.get("search")) {
      clauses.push("(t.vendor_name LIKE ? OR t.description LIKE ?)");
      const q = `%${params.get("search")} %`.replace(" %", "%");
      bindings.push(q, q);
    }
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(params.get("pageSize") ?? 25)),
    );
    const where = `WHERE ${clauses.join(" AND ")}`;
    const orderBy =
      (
        {
          "date-asc": "t.transaction_date ASC,t.created_at ASC",
          "amount-desc": "t.amount_minor DESC,t.transaction_date DESC",
          "amount-asc": "t.amount_minor ASC,t.transaction_date DESC",
          "category-asc": "c.name COLLATE NOCASE ASC,t.transaction_date DESC",
          "category-desc": "c.name COLLATE NOCASE DESC,t.transaction_date DESC",
          "account-asc": "a.name COLLATE NOCASE ASC,t.transaction_date DESC",
          "account-desc": "a.name COLLATE NOCASE DESC,t.transaction_date DESC",
        } as Record<string, string>
      )[params.get("sort") ?? ""] ??
      "t.transaction_date DESC,t.created_at DESC";
    const count = await this.db
      .prepare(`SELECT count(*) count FROM transactions t ${where}`)
      .bind(...bindings)
      .first<{ count: number }>();
    const result = await this.db
      .prepare(
        `SELECT t.*,c.name category_name,a.name account_name FROM transactions t JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, pageSize, (page - 1) * pageSize)
      .all();
    return {
      data: result.results,
      pagination: { page, pageSize, total: count?.count ?? 0 },
    };
  }

  async getTransaction(id: string) {
    return this.db
      .prepare("SELECT * FROM transactions WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .first();
  }
  async createTransaction(
    input: TransactionInput,
    importId: string | null = null,
  ) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO transactions (id,user_id,transaction_date,category_id,account_id,vendor_name,description,amount_minor,transaction_type,transaction_direction,currency,import_id,import_fingerprint,balance_effect_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        this.userId,
        input.transactionDate,
        input.categoryId,
        input.accountId,
        input.vendorName,
        input.description ?? "",
        input.amountMinor,
        input.transactionType,
        input.transactionDirection,
        input.currency ?? "CAD",
        importId,
        input.importFingerprint ?? null,
        this.balanceEffect(input),
        now,
        now,
      )
      .run();
    return this.getTransaction(id);
  }
  async updateTransaction(id: string, input: TransactionInput) {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        "UPDATE transactions SET transaction_date=?,category_id=?,account_id=?,vendor_name=?,description=?,amount_minor=?,transaction_type=?,transaction_direction=?,currency=?,balance_effect_minor=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .bind(
        input.transactionDate,
        input.categoryId,
        input.accountId,
        input.vendorName,
        input.description ?? "",
        input.amountMinor,
        input.transactionType,
        input.transactionDirection,
        input.currency ?? "CAD",
        this.balanceEffect(input),
        now,
        id,
        this.userId,
      )
      .run();
    return result.meta.changes ? this.getTransaction(id) : null;
  }
  async deleteTransaction(id: string) {
    const result = await this.db
      .prepare("DELETE FROM transactions WHERE id=? AND user_id=?")
      .bind(id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  async listTransactionIds(params: URLSearchParams) {
    const clauses = ["t.user_id=?"],
      bindings: unknown[] = [this.userId];
    const filters: Array<[string, string]> = [
      ["startDate", "t.transaction_date >="],
      ["endDate", "t.transaction_date <="],
      ["type", "t.transaction_type ="],
    ];
    for (const [key, sql] of filters) {
      const value = params.get(key);
      if (value) {
        clauses.push(`${sql} ?`);
        bindings.push(value);
      }
    }
    if (params.get("search")) {
      clauses.push("(t.vendor_name LIKE ? OR t.description LIKE ?)");
      const query = `%${params.get("search")}%`;
      bindings.push(query, query);
    }
    const rows = await this.db
      .prepare(
        `SELECT t.id FROM transactions t WHERE ${clauses.join(" AND ")} ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 500`,
      )
      .bind(...bindings)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  async bulkUpdateTransactions(
    ids: string[],
    changes: Partial<
      Pick<
        TransactionInput,
        "accountId" | "categoryId" | "transactionType" | "transactionDirection"
      >
    >,
  ) {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const owned = await this.db
      .prepare(
        `SELECT COUNT(*) count FROM transactions WHERE user_id=? AND id IN (${placeholders})`,
      )
      .bind(this.userId, ...ids)
      .first<{ count: number }>();
    if (owned?.count !== ids.length) return -1;
    const fields: string[] = [],
      values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      fields.push(`${column}=?`);
      values.push(value);
    };
    if (changes.accountId) add("account_id", changes.accountId);
    if (changes.categoryId) add("category_id", changes.categoryId);
    if (changes.transactionType)
      add("transaction_type", changes.transactionType);
    if (changes.transactionDirection)
      add("transaction_direction", changes.transactionDirection);
    fields.push(
      "balance_effect_minor=CASE WHEN COALESCE(?,transaction_direction)='credit' THEN amount_minor ELSE -amount_minor END",
      "updated_at=?",
    );
    values.push(changes.transactionDirection ?? null, new Date().toISOString());
    const results = await this.db.batch(
      ids.map((id) =>
        this.db
          .prepare(
            `UPDATE transactions SET ${fields.join(",")} WHERE id=? AND user_id=?`,
          )
          .bind(...values, id, this.userId),
      ),
    );
    return results.reduce(
      (total, result) => total + Number(result.meta.changes ?? 0),
      0,
    );
  }

  private async activityBreakdown(
    startDate: string,
    endDate: string,
    type: "expense" | "income",
    monthCount: number,
  ) {
    const effect = type === "expense" ? EXPENSE_EFFECT_SQL : INCOME_EFFECT_SQL;
    const [categories, accounts, masterCategories, budget] = await Promise.all([
      this.db
        .prepare(
          `SELECT c.id,c.name,c.master_category_id,c.monthly_budget_minor,COALESCE(SUM(${effect}),0) amount_minor,COUNT(t.id) transaction_count,COALESCE(SUM(CASE WHEN t.transaction_direction=${type === "expense" ? "'credit'" : "'debit'"} THEN t.amount_minor ELSE 0 END),0) reversal_minor FROM categories c LEFT JOIN transactions t ON t.category_id=c.id AND t.user_id=c.user_id AND t.transaction_date BETWEEN ? AND ? AND t.transaction_type=? WHERE c.user_id=? AND c.active=1 AND c.kind=? GROUP BY c.id,c.name,c.master_category_id,c.monthly_budget_minor ORDER BY amount_minor DESC,c.name`,
        )
        .bind(startDate, endDate, type, this.userId, type)
        .all(),
      this.db
        .prepare(
          `SELECT a.id,a.name,COALESCE(c.master_category_id,'unassigned') master_category_id,SUM(${effect}) amount_minor,COUNT(*) transaction_count FROM transactions t JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id WHERE t.user_id=? AND t.transaction_date BETWEEN ? AND ? AND t.transaction_type=? GROUP BY a.id,a.name,c.master_category_id ORDER BY amount_minor DESC`,
        )
        .bind(this.userId, startDate, endDate, type)
        .all(),
      this.db
        .prepare(
          `SELECT COALESCE(mc.id,'unassigned') id,COALESCE(mc.name,'Unassigned') name,SUM(${effect}) amount_minor,COUNT(*) transaction_count FROM transactions t JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id LEFT JOIN master_categories mc ON mc.id=c.master_category_id AND mc.user_id=c.user_id WHERE t.user_id=? AND t.transaction_date BETWEEN ? AND ? AND t.transaction_type=? GROUP BY mc.id,mc.name ORDER BY amount_minor DESC`,
        )
        .bind(this.userId, startDate, endDate, type)
        .all(),
      this.db
        .prepare(
          "SELECT COALESCE(SUM(monthly_budget_minor),0) total FROM categories WHERE user_id=? AND active=1 AND kind=?",
        )
        .bind(this.userId, type)
        .first<{ total: number }>(),
    ]);
    return {
      byCategory: categories.results,
      byAccount: accounts.results,
      byMasterCategory: masterCategories.results,
      totalBudgetMinor: Number(budget?.total ?? 0) * monthCount,
    };
  }

  async rangeSummary(startDate: string, endDate: string) {
    const totals = await this.db
      .prepare(
        `SELECT SUM(CASE WHEN t.transaction_type='income' THEN ${INCOME_EFFECT_SQL} ELSE 0 END) income_minor,SUM(CASE WHEN t.transaction_type='expense' THEN ${EXPENSE_EFFECT_SQL} ELSE 0 END) expense_minor,SUM(CASE WHEN t.transaction_type NOT IN ('transfer') THEN 1 ELSE 0 END) transaction_count FROM transactions t WHERE t.user_id=? AND t.transaction_date BETWEEN ? AND ?`,
      )
      .bind(this.userId, startDate, endDate)
      .first<Record<string, number>>();
    const income = totals?.income_minor ?? 0,
      expense = totals?.expense_minor ?? 0;
    const startMonth = startDate.slice(0, 7),
      endMonth = endDate.slice(0, 7);
    const [startYear, startMonthNumber] = startMonth.split("-").map(Number);
    const [endYear, endMonthNumber] = endMonth.split("-").map(Number);
    const monthCount =
      (endYear! - startYear!) * 12 + endMonthNumber! - startMonthNumber! + 1;
    const [expenseActivity, incomeActivity] = await Promise.all([
      this.activityBreakdown(startDate, endDate, "expense", monthCount),
      this.activityBreakdown(startDate, endDate, "income", monthCount),
    ]);
    const totalBudgetMinor = expenseActivity.totalBudgetMinor;
    return {
      startDate,
      endDate,
      monthCount,
      incomeMinor: income,
      expenseMinor: expense,
      netCashFlowMinor: income - expense,
      transactionCount: totals?.transaction_count ?? 0,
      totalBudgetMinor,
      budgetRemainingMinor: totalBudgetMinor - expense,
      byCategory: expenseActivity.byCategory,
      byMasterCategory: expenseActivity.byMasterCategory,
      byAccount: expenseActivity.byAccount,
      activity: {
        expense: expenseActivity,
        income: incomeActivity,
      },
    };
  }

  async updateBudgets(
    items: Array<{ categoryId: string; monthlyBudgetMinor: number }>,
  ) {
    const now = new Date().toISOString();
    const results = await this.db.batch(
      items.map((item) =>
        this.db
          .prepare(
            "UPDATE categories SET monthly_budget_minor=?,updated_at=? WHERE id=? AND user_id=? AND active=1",
          )
          .bind(item.monthlyBudgetMinor, now, item.categoryId, this.userId),
      ),
    );
    return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  }

  async spendingTrend(
    startDate: string,
    endDate: string,
    type: "expense" | "income",
    categoryId?: string,
    masterCategoryId?: string,
  ) {
    const clauses = [
      "t.user_id=?",
      "t.transaction_date BETWEEN ? AND ?",
      "t.transaction_type=?",
    ];
    const bindings: unknown[] = [this.userId, startDate, endDate, type];
    if (categoryId) {
      clauses.push("c.id=?");
      bindings.push(categoryId);
    }
    if (masterCategoryId) {
      clauses.push("c.master_category_id=?");
      bindings.push(masterCategoryId);
    }
    const actualRows = await this.db
      .prepare(
        `SELECT substr(t.transaction_date,1,7) month,SUM(${type === "expense" ? EXPENSE_EFFECT_SQL : INCOME_EFFECT_SQL}) actual_minor FROM transactions t JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id WHERE ${clauses.join(" AND ")} GROUP BY month ORDER BY month`,
      )
      .bind(...bindings)
      .all<{ month: string; actual_minor: number }>();
    const budgetClauses = ["user_id=?", "active=1", "kind=?"],
      budgetBindings: unknown[] = [this.userId, type];
    if (categoryId) {
      budgetClauses.push("id=?");
      budgetBindings.push(categoryId);
    }
    if (masterCategoryId) {
      budgetClauses.push("master_category_id=?");
      budgetBindings.push(masterCategoryId);
    }
    const budget = await this.db
      .prepare(
        `SELECT COALESCE(SUM(monthly_budget_minor),0) budget_minor FROM categories WHERE ${budgetClauses.join(" AND ")}`,
      )
      .bind(...budgetBindings)
      .first<{ budget_minor: number }>();
    const actualByMonth = new Map(
      actualRows.results.map((row) => [row.month, row.actual_minor]),
    );
    const months: string[] = [];
    const cursor = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`),
      end = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
    while (cursor <= end) {
      months.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const averageMinor = Math.round(
      months.reduce((sum, month) => sum + (actualByMonth.get(month) ?? 0), 0) /
        Math.max(1, months.length),
    );
    return months.map((month) => ({
      month,
      actualMinor: actualByMonth.get(month) ?? 0,
      budgetMinor: budget?.budget_minor ?? 0,
      averageMinor,
    }));
  }
}
