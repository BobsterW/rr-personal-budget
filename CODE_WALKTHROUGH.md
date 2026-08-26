# V7.1 code walkthrough

This guide explains how the application works from the browser down to Cloudflare D1. Read it beside the source files. The inline comments identify important implementation boundaries; this guide explains how those boundaries connect.

## 1. Request flow

For an authenticated screen load, the flow is:

1. `frontend/src/index.html` loads `config.js`, then `app.js`.
2. `app.js` calls `GET /api/v1/auth/me` with `credentials: "include"`.
3. The Worker entry point in `worker/src/index.ts` calls `requireUser` from `auth.ts`.
4. `auth.ts` hashes the cookie token and looks it up in `sessions`.
5. The Worker constructs `BudgetRepository(env.DB, user.id)`.
6. Repository SQL includes `user_id=?`, so only that user's rows are returned.
7. The Worker converts SQLite snake_case fields to camelCase JSON.
8. The frontend stores lookup rows in temporary `state` and renders the selected tab.

The browser never connects to D1 directly and contains no database credentials.

## 2. Frontend files

### `frontend/src/index.html`

This is the semantic structure of the site. It contains:

- The signed-out authentication card.
- The signed-in header and navigation.
- One `<section class="view">` for each application tab.
- Native `<dialog>` elements for transaction, account, balance, purchase, and CSV forms.
- Accessible labels, table headings, status regions, and buttons.

Most sections start hidden. `showView()` in `app.js` activates the section matching the URL hash, such as `#transactions` or `#settings`.

The password fields contain a sibling `.password-toggle` button. The button changes only the input's presentation type between `password` and `text`; it does not store or send the value itself.

### `frontend/src/styles.css`

The first `:root` block defines the design tokens: colours, typography, borders, and shadows. Later groups style the application shell, forms, tables, charts, authentication card, dialogs, and responsive breakpoints.

`[hidden] { display: none !important; }` is important because component classes such as `.auth-screen` define their own display layout. Without this rule, a class declaration could visually override the HTML `hidden` attribute.

The SVG chart is drawn by JavaScript, while CSS controls areas, lines, gridlines, labels, and projected-line dashes.

### `frontend/src/config.js`

This small file supplies the Worker base URL. Local development uses `http://localhost:8787`. The GitHub deployment workflow rewrites it to the production Worker URL before building Pages.

### `frontend/src/app.js`

This is organized conceptually into these sections:

1. Configuration, temporary state, and DOM/format helpers.
2. The shared `api()` client and notification/error handling.
3. Date, CSV, and rendering helpers.
4. Data loaders for transactions, monthly summaries, budgets, net worth, and settings.
5. A delegated document click/change handler for dynamic buttons and selects.
6. Form submit handlers that translate form values into API JSON.
7. Authentication tab, login, registration, password-eye, logout, and startup listeners.

`api()` always includes browser credentials so the HttpOnly session cookie accompanies API requests. It reads the Worker's structured error response and turns it into a useful UI message including the request ID.

The `state` object is not permanent storage. It caches the current user's categories/accounts and the current page of transactions to avoid repeated lookups while rendering forms.

The login bug fixed in V7.1 was caused by reading `event.currentTarget` after `await`. Browsers clear that event property after the synchronous callback returns. V7.1 captures `const formElement = event.currentTarget` before starting asynchronous work, then safely calls `formElement.reset()` afterward. Category and rule forms use the same safe pattern.

Account form values are converted before sending:

- Dollars become integer cents with `cents()`.
- Percentages become integer basis points by multiplying by 100.
- Select values are sent as the exact API enum strings.

### `frontend/scripts/build.mjs`

This intentionally simple build removes the old `dist` folder and copies `frontend/src` into it. There is no bundler or transpiler because the frontend uses browser-native HTML, CSS, and JavaScript.

## 3. Worker files

### `worker/src/index.ts`

This is the Worker entry point and route/controller layer.

At the bottom, Cloudflare calls the exported `fetch()` method. It:

1. Creates a unique request ID.
2. Computes CORS headers for an approved origin.
3. handles `OPTIONS` preflight requests.
4. Rejects unapproved origins.
5. Calls `route()`.
6. Adds security and no-cache headers.
7. Converts thrown errors into controlled JSON.

Inside `route()`, public routes appear before `requireUser`: health, registration, login, and logout. Every financial route appears after `requireUser`, so it cannot run without an active session.

Registration validates the username/password, bcrypt-hashes the password, and uses one D1 batch to create the user, projection assumptions, and starter categories.

Login uses a rolling 15-minute failed-attempt check. Missing usernames still execute bcrypt work, reducing the timing difference between a missing user and an incorrect password. Both cases return the same public message.

`accountInput()` is shared by account creation and editing. It accepts only known account types, liquidity groups, payment frequencies, integer cents, and integer basis points.

### `worker/src/auth.ts`

This module owns credentials and sessions:

- `normalizeUsername()` creates a case-insensitive lookup value.
- `validateUsername()` enforces the permitted username shape.
- `validatePassword()` applies the password policy and bcrypt's 72-byte limit.
- `passwordHash()` and `passwordMatches()` wrap bcrypt at cost 12.
- `randomToken()` produces a 256-bit session secret.
- `digest()` produces the SHA-256 value stored in D1.
- `createSession()` creates the row and cookie.
- `requireUser()` resolves an incoming cookie to a user.
- `destroySession()` deletes it during logout.

The raw password is never stored. The raw session token is not stored in D1.

### `worker/src/repository.ts`

The repository isolates SQL from HTTP routing. Its constructor requires `userId`, making ownership available to every method.

Important groups include:

- Lookup CRUD for categories/accounts.
- Master categories and category assignment.
- Automatic category rules and suggestion learning.
- Account projection settings.
- Historical timeline source rows.
- Planned purchases.
- Filtered/paginated transaction CRUD.
- Monthly summaries and budget/trend calculations.

All external values use D1 `.bind(...)` parameters. Dynamic transaction sorting uses a closed map from UI names to trusted SQL expressions.

Category suggestions prioritize explicit rules, normalized exact merchant history, fuzzy token overlap, then common keywords. Reference numbers and payment-network words are removed before comparing merchants.

### `worker/src/validation.ts`

This module checks transaction payloads before repository insertion. It validates ISO dates, IDs, vendor length, positive integer cents, transaction type, optional description, currency, fingerprints, and signed balance effects.

It returns field-specific issues instead of throwing on every invalid field, allowing the CSV importer to report multiple useful row problems.

### `worker/src/calculations.ts`

This module contains pure projection calculations. It does not access D1, the clock, or the network. Inputs are accounts and assumptions; outputs are monthly projection points. Its purity makes the formulas repeatable in unit tests.

### `worker/src/timeline.ts`

`balanceAt()` reconstructs an account at any requested date:

- If a snapshot exists before the date, it adds later transaction effects.
- If the closest snapshot is after the date, it reverses intervening effects.
- With no snapshot, it accumulates known effects.

`buildNetWorthTimeline()` creates actual values through today, then projects forward using growth, interest, payments, equity, dividends, depreciation, monthly contributions, and planned purchases. Fixed and liquid accounts are aggregated separately.

### `worker/src/http.ts`

`ApiError` carries a safe status/code/message. `readJson()` enforces JSON content type and a one-megabyte limit. `errorResponse()` maps expected database errors to useful public messages while hiding unexpected internals and returning a request ID.

### `worker/src/types.ts`

These TypeScript contracts describe the domain. Amounts are integer cents. Annual rates are integer basis points, where 100 basis points equals 1%. These representations avoid common floating-point money errors.

### `worker/wrangler.jsonc`

This is the Worker deployment source of truth. It defines the entry module, compatibility date, Node compatibility needed by bcrypt, observability, non-secret variables, and the D1 binding/migration directory.

## 4. Database

Migrations are applied in numerical order and should never be edited after production application.

- `0001`: original categories, accounts, imports, transactions, snapshots, projection assumptions, and indexes.
- `0002`: default projection row.
- `0003`: account-specific projection columns.
- `0004`: master categories, category rules, and fixed/liquid classification.
- `0005`: uncategorized fallback rows.
- `0006`: signed transaction balance effects and future purchases.
- `0007`: users, sessions, rate-limit attempts, and full tenant-aware table rebuild.

Migration 0007 gives each financial table a `user_id`. Composite foreign keys such as `(account_id,user_id)` prevent one user's transaction from referencing another user's account. Uniqueness is per user, allowing two people to both create an account named “Chequing.”

`database/seeds/development.sql` contains invented local-only data and a demo bcrypt hash. Never put real financial exports or production credentials in seed files.

## 5. Tests and automation

Worker tests cover password policy/hashing, transaction validation, HTTP errors, projection formulas, and historical timeline behavior.

`pnpm check` performs formatting checks, frontend/Worker lint, generated Worker types, TypeScript checks, unit tests, a Worker deployment dry-run, and a static frontend build.

`.github/workflows/ci.yml` runs those checks for repository changes. `.github/workflows/deploy.yml` repeats validation on `main`, applies remote D1 migrations, deploys the Worker, writes the production API URL into the frontend config, and deploys Pages.

## 6. Suggested reading order

1. `frontend/src/index.html`
2. Top of `frontend/src/app.js`, then `api()`, `enterApp()`, and the bottom event listeners
3. `worker/src/index.ts` from `route()` through authentication and account routes
4. `worker/src/auth.ts`
5. `worker/src/repository.ts`
6. `database/migrations/0007_multi_user_authentication.sql`
7. `worker/src/timeline.ts` and `calculations.ts`
8. Tests beside the corresponding source modules
