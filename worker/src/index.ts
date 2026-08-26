/*
 * CLOUDFLARE WORKER HTTP CONTROLLER
 * Applies origin/security policy, exposes authentication endpoints, requires a
 * session before financial endpoints, validates JSON, and delegates SQL to the
 * repository. `http.ts` converts controlled failures into stable JSON errors.
 */
import { projectAccounts } from "./calculations";
import {
  clearSessionCookie,
  createSession,
  credentials,
  destroySession,
  digest,
  normalizeUsername,
  passwordHash,
  passwordMatches,
  requireUser,
  validatePassword,
} from "./auth";
import { ApiError, errorResponse, json, readJson } from "./http";
import { BudgetRepository } from "./repository";
import { buildNetWorthTimeline } from "./timeline";
import type {
  TimelineAccount,
  TimelineEffect,
  TimelinePurchase,
  TimelineSnapshot,
} from "./timeline";
import type {
  AccountType,
  AccountProjectionInput,
  PaymentFrequency,
  LiquidityClass,
  ProjectionAssumptions,
  TransactionType,
} from "./types";
import { validateTransaction } from "./validation";

const ACCOUNT_TYPES = new Set<AccountType>([
  "cash",
  "chequing",
  "savings",
  "credit_card",
  "investment",
  "asset",
  "liability",
]);
const TRANSACTION_TYPES = new Set<TransactionType>([
  "expense",
  "income",
  "transfer",
  "adjustment",
]);
const PAYMENT_FREQUENCIES = new Set<PaymentFrequency>([
  "none",
  "monthly",
  "yearly",
]);
const LIQUIDITY_CLASSES = new Set<LiquidityClass>(["fixed", "liquid"]);

// Credentialed CORS is emitted only for an explicitly configured frontend.
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  return origin && allowed.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-credentials": "true",
        vary: "Origin",
      }
    : {};
}
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  return (
    !origin ||
    env.ALLOWED_ORIGINS.split(",")
      .map((item) => item.trim())
      .includes(origin)
  );
}
function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "VALIDATION_ERROR", "A JSON object is required.");
  return value as Record<string, unknown>;
}
function requireString(
  body: Record<string, unknown>,
  field: string,
  max = 120,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `${field} is required and must be at most ${max} characters.`,
      [{ field, message: "Invalid value." }],
    );
  return value.trim();
}
function requireDate(value: string | null, field: string): string {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `${field} must use YYYY-MM-DD.`,
    );
  return value;
}
function todayInTimezone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function toCamel(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

// Convert untrusted account JSON into integer cents/basis-points and enums.
function accountInput(body: Record<string, unknown>) {
  const name = requireString(body, "name");
  const accountType = requireString(body, "accountType") as AccountType;
  const paymentFrequency = String(
    body.paymentFrequency ?? "none",
  ) as PaymentFrequency;
  const liquidityClass = String(
    body.liquidityClass ?? "liquid",
  ) as LiquidityClass;
  if (!ACCOUNT_TYPES.has(accountType))
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid account type.");
  if (!PAYMENT_FREQUENCIES.has(paymentFrequency))
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid payment frequency.");
  if (!LIQUIDITY_CLASSES.has(liquidityClass))
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid liquidity class.");
  const integerFields = [
    "annualGrowthBps",
    "paymentAmountMinor",
    "annualInterestBps",
    "annualEquityGainMinor",
    "annualDividendMinor",
    "annualDepreciationBps",
  ] as const;
  const values = Object.fromEntries(
    integerFields.map((field) => [field, body[field] ?? 0]),
  );
  if (integerFields.some((field) => !Number.isSafeInteger(values[field])))
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Account projection values must use integer cents or basis points.",
    );
  if (
    Number(values.paymentAmountMinor) < 0 ||
    Number(values.annualEquityGainMinor) < 0 ||
    Number(values.annualDividendMinor) < 0 ||
    Number(values.annualDepreciationBps) < 0
  )
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Payments, equity, dividends, and depreciation cannot be negative.",
    );
  return {
    name,
    accountType,
    paymentFrequency,
    liquidityClass,
    ...values,
    projectionNotes:
      typeof body.projectionNotes === "string"
        ? body.projectionNotes.slice(0, 500)
        : "",
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Public routes come first. `requireUser` is intentionally placed before every
// budget route and its user ID is injected into the repository constructor.
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method;
  if (path === "/api/v1/health" && method === "GET")
    return json({
      status: "ok",
      currency: env.BASE_CURRENCY,
      timezone: env.APP_TIMEZONE,
    });

  // One D1 batch creates the user, assumptions, and starter categories.
  if (path === "/api/v1/auth/register" && method === "POST") {
    const input = await credentials(request);
    const password = validatePassword(input.password);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const categorySeed = [
      ["Uncategorized expense", "expense"],
      ["Uncategorized income", "income"],
      ["Uncategorized transfer", "transfer"],
      ["Uncategorized adjustment", "adjustment"],
      ["Groceries", "expense"],
      ["Housing", "expense"],
      ["Transportation", "expense"],
      ["Dining", "expense"],
      ["Work Income", "income"],
    ];
    const statements = [
      env.DB.prepare(
        "INSERT INTO users (id,username,username_normalized,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).bind(
        userId,
        input.username,
        normalizeUsername(input.username),
        await passwordHash(password),
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO projection_assumptions (id,user_id,annual_asset_growth_bps,annual_liability_interest_bps,horizon_months,updated_at) VALUES (?,?,?,?,?,?)",
      ).bind(crypto.randomUUID(), userId, 400, 500, 60, now),
      ...categorySeed.map(([name, kind]) =>
        env.DB.prepare(
          "INSERT INTO categories (id,user_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        ).bind(crypto.randomUUID(), userId, name, kind, now, now),
      ),
    ];
    try {
      await env.DB.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        /users\.username_normalized|UNIQUE constraint failed/i.test(
          error.message,
        )
      )
        throw new ApiError(
          409,
          "USERNAME_UNAVAILABLE",
          "That username is already in use.",
        );
      throw error;
    }
    return json({ data: { id: userId, username: input.username } }, 201, {
      "set-cookie": await createSession(userId, env.DB, request),
    });
  }

  // Missing usernames and wrong passwords intentionally share one response.
  if (path === "/api/v1/auth/login" && method === "POST") {
    const input = await credentials(request);
    const normalized = normalizeUsername(input.username);
    const identifierHash = await digest(normalized);
    const ipHash = await digest(
      request.headers.get("cf-connecting-ip") ?? "local",
    );
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) count FROM auth_attempts WHERE succeeded=0 AND created_at>? AND (identifier_hash=? OR ip_hash=?)",
    )
      .bind(since, identifierHash, ipHash)
      .first<{ count: number }>();
    if ((attempts?.count ?? 0) >= 10)
      throw new ApiError(
        429,
        "TOO_MANY_ATTEMPTS",
        "Too many sign-in attempts. Try again in 15 minutes.",
      );
    const user = await env.DB.prepare(
      "SELECT id,username,password_hash FROM users WHERE username_normalized=? AND active=1",
    )
      .bind(normalized)
      .first<{ id: string; username: string; password_hash: string }>();
    const matches = user
      ? await passwordMatches(input.password, user.password_hash)
      : await passwordMatches(
          input.password,
          await passwordHash("TimingOnly1!"),
        );
    await env.DB.prepare(
      "INSERT INTO auth_attempts (id,identifier_hash,ip_hash,succeeded,created_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        identifierHash,
        ipHash,
        user && matches ? 1 : 0,
        new Date().toISOString(),
      )
      .run();
    if (!user || !matches)
      throw new ApiError(
        401,
        "INVALID_CREDENTIALS",
        "Incorrect username or password.",
      );
    return json({ data: { id: user.id, username: user.username } }, 200, {
      "set-cookie": await createSession(user.id, env.DB, request),
    });
  }

  if (path === "/api/v1/auth/logout" && method === "POST") {
    await destroySession(request, env.DB);
    return json({ data: { signedOut: true } }, 200, {
      "set-cookie": clearSessionCookie(request),
    });
  }

  const user = await requireUser(request, env.DB);
  if (path === "/api/v1/auth/me" && method === "GET")
    return json({ data: user });
  const repo = new BudgetRepository(env.DB, user.id);

  if (
    (path === "/api/v1/categories" || path === "/api/v1/accounts") &&
    method === "GET"
  ) {
    const table = path.endsWith("categories") ? "categories" : "accounts";
    return json({
      data: (await repo.listLookup(table)).map((row) => toCamel(row)),
    });
  }
  if (
    (path === "/api/v1/categories" || path === "/api/v1/accounts") &&
    method === "POST"
  ) {
    const body = assertObject(await readJson(request));
    const table = path.endsWith("categories") ? "categories" : "accounts";
    const name = requireString(body, "name");
    if (table === "categories") {
      const kind = requireString(body, "kind") as TransactionType;
      if (!TRANSACTION_TYPES.has(kind))
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid category kind.");
      return json(
        {
          data: toCamel(
            (await repo.createLookup(table, {
              name,
              kind,
              parentName:
                typeof body.parentName === "string" ? body.parentName : null,
              monthlyBudgetMinor: Number.isSafeInteger(body.monthlyBudgetMinor)
                ? body.monthlyBudgetMinor
                : null,
            })) as Record<string, unknown>,
          ),
        },
        201,
      );
    }
    return json(
      {
        data: toCamel(
          (await repo.createLookup(table, accountInput(body))) as Record<
            string,
            unknown
          >,
        ),
      },
      201,
    );
  }
  const lookupMatch = path.match(/^\/api\/v1\/(categories|accounts)\/([^/]+)$/);
  if (lookupMatch?.[1] === "accounts" && method === "PUT") {
    const record = await repo.updateAccount(
      lookupMatch[2]!,
      accountInput(assertObject(await readJson(request))),
    );
    if (!record) throw new ApiError(404, "NOT_FOUND", "Account not found.");
    return json({ data: toCamel(record as Record<string, unknown>) });
  }
  if (lookupMatch && method === "DELETE") {
    const found = await repo.archiveLookup(
      lookupMatch[1] as "categories" | "accounts",
      lookupMatch[2]!,
    );
    if (!found) throw new ApiError(404, "NOT_FOUND", "Record not found.");
    return new Response(null, { status: 204 });
  }
  const categoryMasterMatch = path.match(
    /^\/api\/v1\/categories\/([^/]+)\/master-category$/,
  );
  if (categoryMasterMatch && method === "PUT") {
    const body = assertObject(await readJson(request));
    const masterCategoryId =
      body.masterCategoryId === null || body.masterCategoryId === ""
        ? null
        : requireString(body, "masterCategoryId");
    if (
      !(await repo.updateCategoryMaster(
        categoryMasterMatch[1]!,
        masterCategoryId,
      ))
    )
      throw new ApiError(404, "NOT_FOUND", "Category not found.");
    return json({ data: { id: categoryMasterMatch[1], masterCategoryId } });
  }
  if (path === "/api/v1/master-categories" && method === "GET")
    return json({
      data: (await repo.listMasterCategories()).map((row) => toCamel(row)),
    });
  if (path === "/api/v1/master-categories" && method === "POST") {
    const name = requireString(
      assertObject(await readJson(request)),
      "name",
      80,
    );
    return json(
      {
        data: toCamel(
          (await repo.createMasterCategory(name)) as Record<string, unknown>,
        ),
      },
      201,
    );
  }
  const masterMatch = path.match(/^\/api\/v1\/master-categories\/([^/]+)$/);
  if (masterMatch && method === "DELETE") {
    if (!(await repo.archiveMasterCategory(masterMatch[1]!)))
      throw new ApiError(404, "NOT_FOUND", "Master category not found.");
    return new Response(null, { status: 204 });
  }
  if (path === "/api/v1/category-rules" && method === "GET")
    return json({
      data: (await repo.listCategoryRules()).map((row) => toCamel(row)),
    });
  if (path === "/api/v1/category-rules" && method === "POST") {
    const body = assertObject(await readJson(request));
    const pattern = requireString(body, "pattern", 120),
      categoryId = requireString(body, "categoryId");
    const priority = Number(body.priority ?? 100);
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 999)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Rule priority must be an integer from 1 to 999.",
      );
    return json(
      {
        data: toCamel(
          (await repo.createCategoryRule(
            pattern,
            categoryId,
            priority,
          )) as Record<string, unknown>,
        ),
      },
      201,
    );
  }
  const ruleMatch = path.match(/^\/api\/v1\/category-rules\/([^/]+)$/);
  if (ruleMatch && method === "DELETE") {
    if (!(await repo.archiveCategoryRule(ruleMatch[1]!)))
      throw new ApiError(404, "NOT_FOUND", "Category rule not found.");
    return new Response(null, { status: 204 });
  }
  if (path === "/api/v1/category-suggestions" && method === "POST") {
    const body = assertObject(await readJson(request));
    if (
      !Array.isArray(body.descriptions) ||
      body.descriptions.length > 500 ||
      body.descriptions.some(
        (value) => typeof value !== "string" || value.length > 500,
      )
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "descriptions must be an array of up to 500 strings.",
      );
    return json({
      data: await repo.suggestCategories(body.descriptions as string[]),
    });
  }

  if (path === "/api/v1/transactions" && method === "GET") {
    if (url.searchParams.has("startDate"))
      requireDate(url.searchParams.get("startDate"), "startDate");
    if (url.searchParams.has("endDate"))
      requireDate(url.searchParams.get("endDate"), "endDate");
    if (
      (url.searchParams.get("startDate") ?? "") >
      (url.searchParams.get("endDate") ?? "9999-12-31")
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "startDate must be on or before endDate.",
      );
    const result = await repo.listTransactions(url.searchParams);
    return json({ ...result, data: result.data.map((row) => toCamel(row)) });
  }
  if (path === "/api/v1/transactions" && method === "POST") {
    const validation = validateTransaction(await readJson(request));
    if (!validation.data)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "The request contains invalid fields.",
        validation.issues,
      );
    if (validation.data.currency !== env.BASE_CURRENCY)
      throw new ApiError(
        422,
        "CURRENCY_MISMATCH",
        `Only ${env.BASE_CURRENCY} is supported.`,
      );
    return json(
      {
        data: toCamel(
          (await repo.createTransaction(validation.data)) as Record<
            string,
            unknown
          >,
        ),
      },
      201,
    );
  }
  const transactionMatch = path.match(/^\/api\/v1\/transactions\/([^/]+)$/);
  if (transactionMatch && method === "PUT") {
    const validation = validateTransaction(await readJson(request));
    if (!validation.data)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "The request contains invalid fields.",
        validation.issues,
      );
    const record = await repo.updateTransaction(
      transactionMatch[1]!,
      validation.data,
    );
    if (!record) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
    return json({ data: toCamel(record as Record<string, unknown>) });
  }
  if (transactionMatch && method === "DELETE") {
    if (!(await repo.deleteTransaction(transactionMatch[1]!)))
      throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
    return new Response(null, { status: 204 });
  }

  if (path === "/api/v1/monthly-summary" && method === "GET") {
    const startDate = requireDate(
        url.searchParams.get("startDate"),
        "startDate",
      ),
      endDate = requireDate(url.searchParams.get("endDate"), "endDate");
    if (startDate > endDate)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "startDate must be on or before endDate.",
      );
    return json({ data: await repo.rangeSummary(startDate, endDate) });
  }
  if (path === "/api/v1/budgets" && method === "GET") {
    const categories = (await repo.listLookup("categories")).map((row) =>
      toCamel(row),
    );
    return json({ data: categories });
  }
  if (path === "/api/v1/budgets" && method === "PUT") {
    const body = assertObject(await readJson(request));
    if (!Array.isArray(body.items) || body.items.length > 500)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "items must be an array of up to 500 category budgets.",
      );
    const items = body.items.map((raw) => {
      const item = assertObject(raw),
        categoryId = requireString(item, "categoryId");
      if (
        !Number.isSafeInteger(item.monthlyBudgetMinor) ||
        Number(item.monthlyBudgetMinor) < 0
      )
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Every monthly budget must be a non-negative integer number of cents.",
        );
      return {
        categoryId,
        monthlyBudgetMinor: Number(item.monthlyBudgetMinor),
      };
    });
    const updated = await repo.updateBudgets(items);
    if (updated !== items.length)
      throw new ApiError(
        409,
        "BUDGET_UPDATE_INCOMPLETE",
        "One or more categories no longer exist. Refresh the budget and try again.",
      );
    return json({ data: { updated } });
  }
  if (path === "/api/v1/spending-trends" && method === "GET") {
    const startDate = requireDate(
        url.searchParams.get("startDate"),
        "startDate",
      ),
      endDate = requireDate(url.searchParams.get("endDate"), "endDate");
    const type = url.searchParams.get("type");
    if (startDate > endDate || (type !== "expense" && type !== "income"))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Provide a valid date range and an expense or income type.",
      );
    return json({
      data: await repo.spendingTrend(
        startDate,
        endDate,
        type,
        url.searchParams.get("categoryId") ?? undefined,
        url.searchParams.get("masterCategoryId") ?? undefined,
      ),
    });
  }

  if (path === "/api/v1/future-purchases" && method === "GET")
    return json({
      data: (await repo.listFuturePurchases()).map((row) => toCamel(row)),
    });
  if (path === "/api/v1/future-purchases" && method === "POST") {
    const body = assertObject(await readJson(request));
    const description = requireString(body, "description", 500),
      purchaseDate = requireDate(
        typeof body.purchaseDate === "string" ? body.purchaseDate : null,
        "purchaseDate",
      ),
      accountId = requireString(body, "accountId");
    if (purchaseDate <= todayInTimezone(env.APP_TIMEZONE))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Future purchase date must be after today.",
      );
    if (
      !Number.isSafeInteger(body.amountMinor) ||
      Number(body.amountMinor) <= 0
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "amountMinor must be positive integer cents.",
      );
    return json(
      {
        data: toCamel(
          (await repo.createFuturePurchase(
            description,
            Number(body.amountMinor),
            purchaseDate,
            accountId,
          )) as Record<string, unknown>,
        ),
      },
      201,
    );
  }
  const futurePurchaseMatch = path.match(
    /^\/api\/v1\/future-purchases\/([^/]+)$/,
  );
  if (futurePurchaseMatch && method === "DELETE") {
    if (!(await repo.deleteFuturePurchase(futurePurchaseMatch[1]!)))
      throw new ApiError(404, "NOT_FOUND", "Future purchase not found.");
    return new Response(null, { status: 204 });
  }
  if (path === "/api/v1/net-worth-timeline" && method === "GET") {
    const startDate = requireDate(
        url.searchParams.get("startDate"),
        "startDate",
      ),
      endDate = requireDate(url.searchParams.get("endDate"), "endDate"),
      today = todayInTimezone(env.APP_TIMEZONE);
    if (startDate > endDate)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "startDate must be on or before endDate.",
      );
    const assumptionRow = await env.DB.prepare(
      "SELECT * FROM projection_assumptions WHERE user_id=?",
    )
      .bind(user.id)
      .first<Record<string, number>>();
    if (!assumptionRow)
      throw new ApiError(
        500,
        "CONFIGURATION_ERROR",
        "Projection assumptions are missing.",
      );
    const raw = await repo.timelineData();
    const accounts: TimelineAccount[] = raw.accounts.map((row) => {
      const item = toCamel(row);
      return {
        id: String(item.id),
        accountType: item.accountType as AccountType,
        liquidityClass: item.liquidityClass as LiquidityClass,
        annualGrowthBps: Number(item.annualGrowthBps),
        paymentAmountMinor: Number(item.paymentAmountMinor),
        paymentFrequency: item.paymentFrequency as PaymentFrequency,
        annualInterestBps: Number(item.annualInterestBps),
        annualEquityGainMinor: Number(item.annualEquityGainMinor),
        annualDividendMinor: Number(item.annualDividendMinor),
        annualDepreciationBps: Number(item.annualDepreciationBps),
      };
    });
    const snapshots: TimelineSnapshot[] = raw.snapshots.map((row) => ({
      accountId: String(row.account_id),
      date: String(row.snapshot_date),
      balanceMinor: Number(row.balance_minor),
    }));
    const effects: TimelineEffect[] = raw.effects.map((row) => ({
      accountId: String(row.account_id),
      date: String(row.transaction_date),
      effectMinor: Number(row.balance_effect_minor),
    }));
    const purchases: TimelinePurchase[] = raw.purchases.map((row) => ({
      accountId: String(row.account_id),
      date: String(row.purchase_date),
      amountMinor: Number(row.amount_minor),
    }));
    const assumptions: ProjectionAssumptions = {
      monthlyIncomeMinor: assumptionRow.monthly_income_minor!,
      monthlyExpenseMinor: assumptionRow.monthly_expense_minor!,
      monthlySavingsMinor: assumptionRow.monthly_savings_minor!,
      annualAssetGrowthBps: assumptionRow.annual_asset_growth_bps!,
      annualLiabilityInterestBps: assumptionRow.annual_liability_interest_bps!,
      horizonMonths: assumptionRow.horizon_months!,
    };
    return json({
      data: {
        today,
        points: buildNetWorthTimeline(
          accounts,
          snapshots,
          effects,
          purchases,
          assumptions,
          startDate,
          endDate,
          today,
        ),
      },
    });
  }

  if (path === "/api/v1/balance-snapshots" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT s.*,a.name account_name,a.account_type FROM balance_snapshots s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.user_id=? ORDER BY snapshot_date,account_name",
    )
      .bind(user.id)
      .all();
    return json({ data: rows.results.map((row) => toCamel(row)) });
  }
  if (path === "/api/v1/balance-snapshots" && method === "POST") {
    const body = assertObject(await readJson(request));
    const accountId = requireString(body, "accountId"),
      snapshotDate = requireString(body, "snapshotDate", 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) ||
      !Number.isSafeInteger(body.balanceMinor)
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "A valid date and integer balanceMinor are required.",
      );
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const account = await env.DB.prepare(
      "SELECT id FROM accounts WHERE id=? AND user_id=? AND active=1",
    )
      .bind(accountId, user.id)
      .first();
    if (!account)
      throw new ApiError(
        422,
        "INVALID_ACCOUNT",
        "The selected import account does not exist or is archived.",
      );
    await env.DB.prepare(
      "INSERT INTO balance_snapshots (id,user_id,account_id,snapshot_date,balance_minor,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,account_id,snapshot_date) DO UPDATE SET balance_minor=excluded.balance_minor,note=excluded.note,updated_at=excluded.updated_at",
    )
      .bind(
        id,
        user.id,
        accountId,
        snapshotDate,
        body.balanceMinor,
        typeof body.note === "string" ? body.note : "",
        now,
        now,
      )
      .run();
    return json(
      {
        data: { id, accountId, snapshotDate, balanceMinor: body.balanceMinor },
      },
      201,
    );
  }

  if (path === "/api/v1/projection" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT * FROM projection_assumptions WHERE user_id=?",
    )
      .bind(user.id)
      .first<Record<string, number>>();
    if (!row)
      throw new ApiError(
        500,
        "CONFIGURATION_ERROR",
        "Projection assumptions are missing.",
      );
    const accountRows = await env.DB.prepare(
      "WITH latest AS (SELECT account_id,MAX(snapshot_date) d FROM balance_snapshots WHERE user_id=? GROUP BY account_id) SELECT a.*,COALESCE(s.balance_minor,0) balance_minor FROM accounts a LEFT JOIN latest l ON l.account_id=a.id LEFT JOIN balance_snapshots s ON s.account_id=l.account_id AND s.snapshot_date=l.d AND s.user_id=a.user_id WHERE a.user_id=? AND a.active=1 ORDER BY a.name",
    )
      .bind(user.id, user.id)
      .all();
    const assumptions: ProjectionAssumptions = {
      monthlyIncomeMinor: row.monthly_income_minor!,
      monthlyExpenseMinor: row.monthly_expense_minor!,
      monthlySavingsMinor: row.monthly_savings_minor!,
      annualAssetGrowthBps: row.annual_asset_growth_bps!,
      annualLiabilityInterestBps: row.annual_liability_interest_bps!,
      horizonMonths: row.horizon_months!,
    };
    const accounts: AccountProjectionInput[] = accountRows.results.map(
      (raw) => {
        const account = toCamel(raw) as Record<string, unknown>;
        return {
          id: String(account.id),
          name: String(account.name),
          accountType: account.accountType as AccountType,
          liquidityClass: account.liquidityClass as LiquidityClass,
          balanceMinor: Number(account.balanceMinor),
          annualGrowthBps: Number(account.annualGrowthBps),
          paymentAmountMinor: Number(account.paymentAmountMinor),
          paymentFrequency: account.paymentFrequency as PaymentFrequency,
          annualInterestBps: Number(account.annualInterestBps),
          annualEquityGainMinor: Number(account.annualEquityGainMinor),
          annualDividendMinor: Number(account.annualDividendMinor),
          annualDepreciationBps: Number(account.annualDepreciationBps),
        };
      },
    );
    const points = projectAccounts(accounts, assumptions);
    return json({
      data: {
        assumptions,
        accounts,
        startAssetsMinor: points[0]?.assetsMinor ?? 0,
        startLiabilitiesMinor: points[0]?.liabilitiesMinor ?? 0,
        points,
      },
    });
  }
  if (path === "/api/v1/projection" && method === "PUT") {
    const body = assertObject(await readJson(request));
    const fields = [
      "monthlyIncomeMinor",
      "monthlyExpenseMinor",
      "monthlySavingsMinor",
      "annualAssetGrowthBps",
      "annualLiabilityInterestBps",
      "horizonMonths",
    ] as const;
    if (fields.some((field) => !Number.isSafeInteger(body[field])))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "All projection assumptions must be integers.",
      );
    if (Number(body.horizonMonths) < 1 || Number(body.horizonMonths) > 600)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "horizonMonths must be between 1 and 600.",
      );
    await env.DB.prepare(
      "UPDATE projection_assumptions SET monthly_income_minor=?,monthly_expense_minor=?,monthly_savings_minor=?,annual_asset_growth_bps=?,annual_liability_interest_bps=?,horizon_months=?,updated_at=? WHERE user_id=?",
    )
      .bind(
        ...fields.map((field) => body[field]),
        new Date().toISOString(),
        user.id,
      )
      .run();
    return json({ data: body });
  }

  if (path === "/api/v1/imports" && method === "POST") {
    const body = assertObject(await readJson(request));
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "rows must contain 1–500 transactions.",
      );
    const accountId = requireString(body, "accountId"),
      fileName = requireString(body, "fileName", 200),
      importId = crypto.randomUUID(),
      now = new Date().toISOString();
    let accepted = 0,
      duplicates = 0,
      rejected = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const statements: D1PreparedStatement[] = [];
    for (const [index, raw] of rows.entries()) {
      const candidate = assertObject(raw);
      candidate.accountId = accountId;
      const validation = validateTransaction(candidate);
      if (!validation.data || validation.data.currency !== env.BASE_CURRENCY) {
        rejected += 1;
        errors.push({
          row: index + 1,
          message:
            validation.issues.map((item) => item.message).join(" ") ||
            `Only ${env.BASE_CURRENCY} is supported.`,
        });
        continue;
      }
      const normalized = [
        validation.data.transactionDate,
        validation.data.accountId,
        validation.data.vendorName.toLowerCase(),
        validation.data.amountMinor,
        validation.data.transactionType,
      ].join("|");
      validation.data.importFingerprint = await sha256(normalized);
      const id = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO transactions (id,user_id,transaction_date,category_id,account_id,vendor_name,description,amount_minor,transaction_type,currency,import_id,import_fingerprint,balance_effect_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          user.id,
          validation.data.transactionDate,
          validation.data.categoryId,
          accountId,
          validation.data.vendorName,
          validation.data.description ?? "",
          validation.data.amountMinor,
          validation.data.transactionType,
          env.BASE_CURRENCY,
          importId,
          validation.data.importFingerprint,
          validation.data.balanceEffectMinor ??
            (validation.data.transactionType === "expense"
              ? -validation.data.amountMinor
              : validation.data.transactionType === "income"
                ? validation.data.amountMinor
                : null),
          now,
          now,
        ),
      );
    }
    await env.DB.prepare(
      "INSERT INTO imports (id,user_id,file_name,account_id,row_count,imported_count,duplicate_count,rejected_count,created_at) VALUES (?,?,?,?,?,0,0,0,?)",
    )
      .bind(importId, user.id, fileName, accountId, rows.length, now)
      .run();
    if (statements.length) {
      const results = await env.DB.batch(statements);
      accepted = results.reduce(
        (sum, result) => sum + (result.meta.changes ?? 0),
        0,
      );
      duplicates = statements.length - accepted;
    }
    await env.DB.prepare(
      "UPDATE imports SET imported_count=?,duplicate_count=?,rejected_count=? WHERE id=? AND user_id=?",
    )
      .bind(accepted, duplicates, rejected, importId, user.id)
      .run();
    return json(
      {
        data: {
          id: importId,
          rowCount: rows.length,
          accepted,
          duplicates,
          rejected,
          errors,
        },
      },
      201,
    );
  }
  throw new ApiError(404, "NOT_FOUND", "Route not found.");
}

// Cloudflare calls `fetch` per request. Request-specific data stays local, and
// the generated request ID connects a browser error to structured Worker logs.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID(),
      headers = cors(request, env);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    try {
      if (!originAllowed(request, env))
        throw new ApiError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "Request origin is not allowed.",
        );
      const response = await route(request, env);
      Object.entries(headers).forEach(([key, value]) =>
        response.headers.set(key, value),
      );
      response.headers.set("x-request-id", requestId);
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      if (!(error instanceof ApiError))
        console.error(
          JSON.stringify({
            level: "error",
            requestId,
            message: "Unhandled request error",
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage:
              error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }),
        );
      return errorResponse(error, requestId, headers);
    }
  },
} satisfies ExportedHandler<Env>;
