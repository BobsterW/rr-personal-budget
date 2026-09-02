# R&R Budget v7.8

A private, multi-user budget and net-worth application inspired by `R&R Expenses Tracking 06-29-2026.xlsx`. Every signed-in user has an independent transaction ledger, categories, accounts, budgets, balances, imports, and projections.

## V7.8 changes

- Renames Balance History to Account Balance, adds deletion, and treats every
  future-dated balance as an authoritative projection anchor. Account variables
  continue from each newly supplied balance.
- Adds editing for Projection Rules.
- Makes 500-row bulk transaction updates and deletions safe for D1 by using
  bounded SQL chunks, and adds Delete to the bulk toolbar.
- Adds a first-class Refund transaction type. Refunds display as positive
  amounts but reduce expense and budget totals. CSV imports automatically match
  equal incoming and outgoing amounts, reuse the original expense category when
  available, and submit in D1-safe 40-row chunks.
- Removes user-facing money-direction controls. The application derives the
  stored balance direction from the selected transaction type and CSV sign.

## V7.7 changes

- Posts monthly, yearly, and once-only Projection Rules on their actual
  scheduled dates. Annual costs now appear as annual steps instead of being
  averaged across twelve months.
- Replaces the separate planned-purchase interface with once-only Projection
  Rules. Legacy planned-purchase records remain stored for compatibility but
  are no longer included in new projections.
- Gives every selected net-worth account a stable colour, strengthens the total
  net-worth line, and lets a click or keyboard selection show dated dollar
  labels for either an account or total net worth.
- Adds explicit vendor, category, and account filters to Transactions, including
  the bulk "select all filtered" workflow.
- Removes the Monthly Activity trend dropdown. Clicking a master-category
  donut slice, ranked category, or account bar now filters the trend directly.
- Keeps category and account bar lengths proportional to the largest visible
  dollar amount, without minimum widths or percentage labels.

## V7.6 changes

- Adds bulk transaction editing with page selection, all-filtered selection,
  checkboxes, Shift range selection, and Ctrl/click toggling. Up to 500 selected
  transactions can have account, category, type, or debit/credit direction
  changed in one controlled request.
- Makes Monthly Activity switch between Expenses and Income without duplicating
  the page. The master-category donut now filters ranked categories, account
  totals, budget/target tracking, and the trend chart in either mode.
- Sizes category and account bars proportionally to their dollar values and
  displays dollar labels only—no percentages on the bars.
- Rebuilds the by-account net-worth chart around a zero line: assets stack above
  zero in solid colours, liabilities stack below zero with striped fills, and
  the total net-worth line remains visible over both.
- Adds account-aware recurring projection rules for income, expenses, and
  transfers. Rules post projected money to real accounts rather than a synthetic
  projected-cash-flow account.
- Removes the fixed-height Monthly Activity trend area so cards shrink with the
  chart at narrow widths.
- Adds migration `0009_projection_rules.sql`; V7.5 remains unchanged in its
  separate directory.

## V7.5 changes

- Separates transaction type from money direction. Expenses can now be debits
  (purchases) or credits (refunds), and refunds reduce category spending,
  budgets, trends, and account balance effects.
- Adds the same debit/credit choice to CSV previews and infers it from signed
  amount or separate debit/credit columns.
- Replaces the master/category lists with an interactive master-category donut
  and ranked category bars. Selecting a donut slice filters the ranking.
- Adds a fixed/liquid versus by-account toggle to the net-worth timeline. Each
  account can be shown or hidden, assets/liabilities can be selected together,
  and hover/focus details show the dated balance and changes.
- Replaces the horizontal navigation with a collapsible desktop sidebar and a
  mobile slide-over menu. Mobile transaction tables become readable cards and
  all new charts fit without horizontal page scrolling.
- Adds migration `0008_transaction_direction.sql`; V7.4 remains unchanged in
  its separate directory.

## V7.4 changes

- Rebuilds the Monthly Spending expense and income charts in the same
  full-width, responsive visual style as the net-worth chart.
- Adds month names, dollar-axis labels, and point-value labels for actual,
  budget, and average-actual lines.
- Preserves the V7.3 local D1 data and deployment workflow.

## V7.3 changes

- Makes the actual/projected net-worth chart a full-width responsive card with
  no horizontal chart scrollbar.
- Moves projection assumptions into a horizontal card below the graph.
- Removes the global liability-interest and projection-month controls. The
  graph's selected end date now determines the saved projection horizon.
- Keeps the V7.2 reliability, form-handling, and projection improvements.

## V7.2 changes

- Preserves the local V7.1 D1 state when this version is created.
- Corrects asynchronous form handling for transactions, balances, purchases,
  projections, accounts, budgets, and CSV imports.
- Replaces the browser's vague `Failed to fetch` message with the unreachable
  Worker URL and an instruction to check the Worker terminal.
- Constrains the net-worth chart to its card so it cannot widen the page.
- Removes asset-growth and depreciation inputs and effects while retaining
  income, expenses, savings, payments, interest, equity, and dividends.

## Architecture

- `frontend/`: static HTML, CSS, and JavaScript for Cloudflare Pages
- `worker/`: TypeScript REST API for Cloudflare Workers
- `database/`: forward-only Cloudflare D1 migrations and invented development seeds
- `.github/workflows/`: pull-request checks and main-branch production deployment

The browser calls the same-origin Pages API relay with credentialed `fetch` requests. The relay forwards to the dedicated Worker, and only the Worker can access D1. V7.8 retains bcrypt password authentication, server-side sessions, ownership-aware foreign keys, API-level tenant scoping, visible-password controls, and corrected asynchronous form handling. This directory preserves all earlier versions separately.

For a detailed, file-by-file explanation, read [`CODE_WALKTHROUGH.md`](CODE_WALKTHROUGH.md).

## Multi-user data model

- `users`: display username, unique normalized username, bcrypt password hash, and account status.
- `sessions`: random login sessions; D1 stores only the SHA-256 token hash. The raw token is sent only in an `HttpOnly` cookie.
- Every financial table carries `user_id`. Accounts, categories, master categories, imports, transactions, balance snapshots, category rules, projection assumptions, and future purchases are user-owned.
- Composite foreign keys such as `(account_id,user_id)` prevent a record from referencing another user's account even if application code makes a mistake.
- Names and import fingerprints are unique within a user rather than globally, so different users can use the same category and account names.
- Existing V5 data is preserved under a disabled `legacy-v5-owner` during migration. Assign it deliberately before removing that disabled record.

## Workbook translation

The source workbook contains Expense Log, Income Log, Cash Flow, Global, Investments, and Thoughts tabs. This application translates them as follows:

| Workbook concept                    | Application concept                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Expense/Income logs                 | One typed transaction ledger                          |
| Monthly budget and category rollups | Detailed and master-category spending summaries       |
| Mastercard/card column              | Editable accounts and cards                           |
| Assets and liabilities              | Accounts with dated balance snapshots                 |
| Net worth                           | Latest asset balances minus latest liability balances |
| Investment projection inputs        | Explicit, editable projection assumptions             |

The workbook contained broken and Excel-version-sensitive formulas. The app does not reproduce those errors. It uses deterministic calculations covered by tests.

## Financial conventions

- Base currency: CAD.
- Amounts are positive integer cents. `transaction_type` identifies income,
  expense, transfer, or adjustment; `transaction_direction` records whether
  money left (`debit`) or entered (`credit`) the account. An expense credit is
  a refund and reduces net expenses without being misclassified as income.
- Transfers are excluded from income and expense totals.
- Liability balance snapshots are negative; the projection converts their magnitude to a positive liability total.
- Dates use `YYYY-MM-DD`. Calendar-month selection uses the `America/Edmonton` timezone in the frontend.
- Projection: each account uses fixed/liquid classification plus its equity and
  dividend settings. Explicit recurring rules route projected income, expenses,
  and transfers through selected accounts. The timeline can show either stacked
  fixed/liquid net worth or individual account layers. It is a planning estimate,
  not financial advice.
- The full-width timeline displays monthly currency values, gridlines, tooltips, historical/projected styling, and a today marker.
- Historical net worth starts from dated account balance snapshots and applies each transaction's signed balance effect. Expenses reduce balances and income raises balances. Imported debit/credit signs are preserved; legacy transfers with no known direction are excluded rather than guessed.
- Once-only Projection Rules reduce or increase the selected account on their
  exact scheduled date. Monthly and yearly rules likewise post as discrete
  events instead of being averaged across the year. The timeline distinguishes
  historical and projected values and includes a vertical marker for today.

## Prerequisites

- Node.js 22+
- pnpm 11 (Corepack can install the pinned version)
- A Cloudflare account for deployment
- A GitHub account for source hosting and CI/CD

## Local setup

```bash
pnpm install
pnpm typecheck
cd worker
npx wrangler d1 migrations apply rr-budget --local
pnpm db:seed:local
pnpm dev
```

In a second terminal:

```bash
pnpm --filter @rr-budget/frontend build
pnpm --filter @rr-budget/frontend dev
```

Open `http://localhost:8788`. The checked-in frontend configuration points to the local Worker at `http://localhost:8787`.

The invented development seed provides `demo` / `DemoUser1!`. Do not use that credential in production.

The local frontend derives the Worker hostname from the page URL. Therefore,
both `http://localhost:8788` and `http://127.0.0.1:8788` work without mixing
cookie sites. Keep both development terminals running while using the app.

Run all verification:

```bash
pnpm check
```

`pnpm check` includes Wrangler's production deployment dry run.

## API overview

All routes are under `/api/v1`:

- `GET /health`
- `POST /auth/register`; `POST /auth/login`; `POST /auth/logout`; `GET /auth/me`
- `GET|POST /transactions`; `PUT|DELETE /transactions/:id`
- `GET|POST /categories`; `DELETE /categories/:id` archives it
- `GET|POST /master-categories`; `PUT /categories/:id/master-category` assigns rollups
- `GET|POST /category-rules`; `POST /category-suggestions` suggests import categories
- `GET|POST /accounts`; `PUT /accounts/:id` edits projection settings; `DELETE /accounts/:id` archives it
- `GET /monthly-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET|PUT /budgets` manages monthly category targets
- `GET /spending-trends` returns actual, budget, and average monthly series
- `GET|POST /balance-snapshots`
- `GET|PUT /projection`
- `GET /net-worth-timeline?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET|POST /future-purchases`; `DELETE /future-purchases/:id`
- `POST /imports` accepts a validated batch from the CSV preview

Errors use `{ "error": { "code", "message", "details?", "requestId" } }`. Request bodies are limited to 1 MB, and imports to 500 rows per request.

All routes except health, registration, login, and logout require a valid session. Invalid logins deliberately return the generic message `Incorrect username or password` to avoid revealing registered usernames. Registration requires a unique username and a password with at least eight characters, a capital letter, a number, and a special character. Bcrypt inputs are capped at 72 UTF-8 bytes.

## CSV import

The frontend accepts general CSV files, the tested Neo Mastercard export format (`Transaction Date`, `Posted Date`, `Status`, `Description`, `Amount`), and headerless CIBC exports (`date, description, debit, credit`). It safely parses quoted fields, maps amount or separate debit/credit columns, and previews every row. Large files are transparently sent in safe 40-row API batches. Every included row has an editable type, required category, and optional description. Equal incoming and outgoing amounts are classified as refunds unless their descriptions identify transfers; historical same-account expenses are also checked during import. Categories are suggested in priority order from user rules, normalized exact merchant history, similar merchant history, and expanded merchant-keyword groups. Normalization removes common payment noise and long reference numbers, and similar merchants use token overlap with a confidence threshold. Unmatched rows use the appropriate Uncategorized category. Dates must be ISO `YYYY-MM-DD`; only CAD is accepted.

The included `test/fixtures/mastercard-sample.csv` is invented. Never commit real exports. Direct bank connectivity is intentionally excluded until a vetted provider and consent model are approved.

## Create Cloudflare resources

Do these steps only after reviewing the local application.

1. Authenticate: `npx wrangler login`.
2. Create D1: `npx wrangler d1 create rr-budget`.
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `worker/wrangler.jsonc` with the returned ID.
4. Create the Pages project: `npx wrangler pages project create rr-budget`.
5. Apply remote migrations: from `worker/`, run `npx wrangler d1 migrations apply rr-budget --remote`.
6. Do **not** apply `database/seeds/development.sql` remotely.

## Authentication and production security

V6 has application-level accounts. Sessions use `HttpOnly`, `SameSite`, and production `Secure` cookie attributes; modifying requests reject unapproved browser origins. Prefer a custom domain that serves the frontend and `/api` on the same site. Cloudflare Access may still be added as defense in depth, but it is no longer the only authentication layer.

Set the GitHub environment variable `FRONTEND_ORIGIN` to the exact Pages/custom origin (for example `https://rr-budget.pages.dev`). The deployment workflow inserts it into the Worker CORS allowlist. Do not include a trailing slash. The same-origin Pages gateway in `frontend/functions/api/[[path]].js` contains the deployed Worker origin; update that constant only if the Worker name or account subdomain changes.

For a public deployment, also add Cloudflare Turnstile to registration and repeated failed logins, configure rate limiting at the edge, and plan password recovery before inviting users who cannot be supported manually.

## GitHub and deployment

Push this repository to GitHub on a `codex/` feature branch and open a pull request. Pull requests run format, lint, type, test, and build checks. A successful push or merge to `main` applies D1 migrations, deploys the Worker, then deploys Pages.

Configure GitHub:

| Name                       | Kind     | Purpose                                                       |
| -------------------------- | -------- | ------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | Secret   | Least-privilege token for the Worker, D1, and Pages project   |
| `CLOUDFLARE_ACCOUNT_ID`    | Secret   | Cloudflare account identifier                                 |
| `FRONTEND_ORIGIN`          | Variable | Exact Pages origin, for example `https://rr-budget.pages.dev` |
| `CLOUDFLARE_PAGES_PROJECT` | Variable | Pages project name, for example `rr-budget`                   |

Update `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` with the production Pages origin before deploying. Protect the GitHub `production` environment and require review if desired. For stricter least privilege, use separate API tokens for D1/Worker and Pages and split the workflow secrets.

## Backups, export, and deletion

- Cloudflare D1 provides recovery features, but periodically export important data and confirm the export can be restored.
- Keep exported financial data encrypted and outside the repository.
- Archive categories and accounts instead of deleting referenced records.
- Transaction deletion is permanent in the application; add an audit log or soft-delete migration before a broad public launch.
- To delete the system, export needed data, then remove its Pages project, Worker, D1 database, and GitHub secrets.

## Troubleshooting

- `DB is undefined`: verify the D1 binding is named `DB` and regenerate types with `pnpm --filter @rr-budget/worker typecheck`.
- CORS error: add the exact frontend origin to `ALLOWED_ORIGINS`; do not use `*` in production.
- Empty UI: apply local migrations and run the invented development seed.
- CSV rows rejected: confirm ISO dates, choose an account and category for each included row, and review the row type. Imported amounts are normalized to positive values.
- Deployment fails at migrations: confirm the D1 database ID, token permissions, and database name.

## Known limitations

- Single currency (CAD); multiple isolated users are supported.
- Direct Mastercard/bank API connections are not included.
- CSV dates require ISO format in this first version.
- Spending analytics and budget variance support user-selected date ranges.
- The projection is intentionally simpler than the workbook's cattle-specific investment model.
