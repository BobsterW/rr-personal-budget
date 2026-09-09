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
import { importFingerprintSource } from "./importFingerprint";
import { BudgetRepository } from "./repository";
import { buildNetWorthTimeline } from "./timeline";
import type {
  TimelineAccount,
  TimelineEffect,
  TimelineSnapshot,
} from "./timeline";
import type {
  AccountType,
  AccountProjectionInput,
  PaymentFrequency,
  LiquidityClass,
  ProjectionAssumptions,
  ProjectionRule,
  ProjectionRuleFrequency,
  ProjectionRuleType,
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
  "refund",
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
const PROJECTION_RULE_TYPES = new Set<ProjectionRuleType>([
  "income",
  "expense",
  "transfer",
]);
const PROJECTION_RULE_FREQUENCIES = new Set<ProjectionRuleFrequency>([
  "monthly",
  "yearly",
  "once",
]);

// Credentialed CORS is emitted only for an explicitly configured frontend.
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  return origin && allowed.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers":
          "content-type,x-page-session,x-workspace-id",
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

type WorkspaceRole = "owner" | "editor" | "viewer";
interface WorkspaceAccess {
  id: string;
  name: string;
  role: WorkspaceRole;
  dataOwnerUserId: string;
  ownerUsername: string;
}
async function listWorkspaces(db: D1Database, userId: string) {
  const result = await db
    .prepare(
      "SELECT w.id,w.name,m.role,owner.username owner_username FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.data_owner_user_id WHERE m.user_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,w.name",
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return result.results.map(toCamel);
}
async function workspaceAccess(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<WorkspaceAccess> {
  const requested = request.headers.get("x-workspace-id");
  const row = await db
    .prepare(
      `SELECT w.id,w.name,w.data_owner_user_id,m.role,owner.username owner_username FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.data_owner_user_id WHERE m.user_id=? ${requested ? "AND w.id=?" : "ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END LIMIT 1"}`,
    )
    .bind(...(requested ? [userId, requested] : [userId]))
    .first<{
      id: string;
      name: string;
      data_owner_user_id: string;
      role: WorkspaceRole;
      owner_username: string;
    }>();
  if (!row)
    throw new ApiError(
      403,
      "WORKSPACE_ACCESS_DENIED",
      "You do not have access to this budget.",
    );
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    dataOwnerUserId: row.data_owner_user_id,
    ownerUsername: row.owner_username,
  };
}
function assertWorkspacePermission(
  role: WorkspaceRole,
  path: string,
  method: string,
) {
  if (role === "owner") return;
  if (role === "editor") {
    if (path.startsWith("/api/v1/workspace"))
      throw new ApiError(
        403,
        "OWNER_REQUIRED",
        "Only the budget owner can manage members or permanently delete archived items.",
      );
    return;
  }
  const viewerRead =
    method === "GET" &&
    (path === "/api/v1/accounts" ||
      path === "/api/v1/categories" ||
      path === "/api/v1/master-categories" ||
      path === "/api/v1/monthly-summary" ||
      path === "/api/v1/spending-trends" ||
      path === "/api/v1/cash-flow-trends" ||
      path === "/api/v1/net-worth-timeline" ||
      path === "/api/v1/projection" ||
      path === "/api/v1/balance-snapshots" ||
      path === "/api/v1/projection-rules" ||
      path === "/api/v1/website-preferences");
  if (!viewerRead)
    throw new ApiError(
      403,
      "VIEW_ONLY",
      "Viewers can only open Monthly Activity and Net Worth.",
    );
}
async function audit(
  db: D1Database,
  userId: string,
  workspaceId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
) {
  await db
    .prepare(
      "INSERT INTO audit_events(id,actor_user_id,workspace_id,action,target_type,target_id,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      userId,
      workspaceId,
      action,
      targetType,
      targetId,
      new Date().toISOString(),
    )
    .run();
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
    const workspaceId = crypto.randomUUID();
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
      env.DB.prepare(
        "INSERT INTO workspaces(id,name,data_owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).bind(workspaceId, `${input.username}'s Budget`, userId, now, now),
      env.DB.prepare(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).bind(workspaceId, userId, "owner", now, now),
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
    const session = await createSession(userId, env.DB, request, false);
    return json(
      {
        data: {
          id: userId,
          username: input.username,
          platformRole: "standard",
          workspaces: [
            {
              id: workspaceId,
              name: `${input.username}'s Budget`,
              role: "owner",
            },
          ],
          workspaceId,
          pageSessionKey: session.pageSessionKey,
        },
      },
      201,
      { "set-cookie": session.cookie },
    );
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
      "SELECT id,username,password_hash,platform_role FROM users WHERE username_normalized=? AND active=1",
    )
      .bind(normalized)
      .first<{
        id: string;
        username: string;
        password_hash: string;
        platform_role: "standard" | "admin";
      }>();
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
    const session = await createSession(
      user.id,
      env.DB,
      request,
      input.keepSignedIn,
    );
    const workspaces = await listWorkspaces(env.DB, user.id);
    await env.DB.prepare(
      "INSERT INTO usage_events(id,user_id,event_type,created_at) VALUES(?,?,?,?)",
    )
      .bind(crypto.randomUUID(), user.id, "login", new Date().toISOString())
      .run();
    return json(
      {
        data: {
          id: user.id,
          username: user.username,
          platformRole: user.platform_role,
          workspaces,
          workspaceId: workspaces[0]?.id ?? null,
          pageSessionKey: session.pageSessionKey,
        },
      },
      200,
      { "set-cookie": session.cookie },
    );
  }

  if (path === "/api/v1/auth/logout" && method === "POST") {
    await destroySession(request, env.DB);
    return json({ data: { signedOut: true } }, 200, {
      "set-cookie": clearSessionCookie(request),
    });
  }

  const user = await requireUser(request, env.DB);
  if (path === "/api/v1/auth/me" && method === "GET") {
    const workspaces = await listWorkspaces(env.DB, user.id);
    return json({
      data: { ...user, workspaces, workspaceId: workspaces[0]?.id ?? null },
    });
  }

  // Platform administration never grants access to another member's finances.
  if (path.startsWith("/api/v1/platform/")) {
    if (user.platformRole !== "admin")
      throw new ApiError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "Platform administrator access is required.",
      );
    if (path === "/api/v1/platform/users" && method === "GET") {
      const search = (url.searchParams.get("search") ?? "").slice(0, 80),
        role = url.searchParams.get("role");
      const clauses = ["1=1"],
        values: unknown[] = [];
      if (search) {
        clauses.push("username LIKE ?");
        values.push(`%${search}%`);
      }
      if (role === "standard" || role === "admin") {
        clauses.push("platform_role=?");
        values.push(role);
      }
      const rows = await env.DB.prepare(
        `SELECT id,username,platform_role,active,created_at FROM users WHERE ${clauses.join(" AND ")} ORDER BY username LIMIT 250`,
      )
        .bind(...values)
        .all<Record<string, unknown>>();
      return json({ data: rows.results.map(toCamel) });
    }
    const platformUser = path.match(/^\/api\/v1\/platform\/users\/([^/]+)$/);
    if (platformUser && method === "PATCH") {
      const body = assertObject(await readJson(request));
      const platformRole = body.platformRole,
        active = body.active;
      if (
        platformUser[1] === user.id &&
        (platformRole !== "admin" || active === false)
      )
        throw new ApiError(
          422,
          "LAST_ADMIN_SAFEGUARD",
          "You cannot remove or disable your own administrator access.",
        );
      if (platformRole !== "standard" && platformRole !== "admin")
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid platform role.");
      if (typeof active !== "boolean")
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "active must be true or false.",
        );
      await env.DB.prepare(
        "UPDATE users SET platform_role=?,active=?,updated_at=? WHERE id=?",
      )
        .bind(
          platformRole,
          active ? 1 : 0,
          new Date().toISOString(),
          platformUser[1],
        )
        .run();
      if (!active)
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?")
          .bind(platformUser[1])
          .run();
      await audit(
        env.DB,
        user.id,
        null,
        "platform_user_updated",
        "user",
        platformUser[1]!,
      );
      return json({ data: { id: platformUser[1], platformRole, active } });
    }
    if (path === "/api/v1/platform/usage" && method === "GET") {
      const data = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM users WHERE active=1) total_users,(SELECT ROUND(COUNT(*)*1.0/NULLIF(COUNT(DISTINCT user_id),0),1) FROM usage_events WHERE event_type='login' AND created_at>=datetime('now','-30 days')) average_uses_per_user,(SELECT ROUND(COUNT(*)*1.0/NULLIF(COUNT(DISTINCT user_id),0),1) FROM transactions) average_transactions_per_user",
      ).first<Record<string, unknown>>();
      return json({ data: toCamel(data ?? {}) });
    }
    throw new ApiError(404, "NOT_FOUND", "Platform route not found.");
  }

  // Invitations are addressed to the signed-in user, so they are resolved
  // before selecting a workspace the recipient does not yet belong to.
  if (path === "/api/v1/invitations" && method === "GET") {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE workspace_invitations SET status='expired',updated_at=? WHERE invited_user_id=? AND status='pending' AND expires_at<=?",
    )
      .bind(now, user.id, now)
      .run();
    const rows = await env.DB.prepare(
      "SELECT i.id,i.role,i.expires_at,i.created_at,w.name workspace_name,u.username inviter_username FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id JOIN users u ON u.id=i.inviter_user_id WHERE i.invited_user_id=? AND i.status='pending' AND i.expires_at>? ORDER BY i.created_at DESC",
    )
      .bind(user.id, now)
      .all<Record<string, unknown>>();
    return json({ data: rows.results.map(toCamel) });
  }
  const invitationResponse = path.match(
    /^\/api\/v1\/invitations\/([^/]+)\/(accept|decline)$/,
  );
  if (invitationResponse && method === "POST") {
    const now = new Date().toISOString();
    const invitation = await env.DB.prepare(
      "SELECT id,workspace_id,role FROM workspace_invitations WHERE id=? AND invited_user_id=? AND status='pending' AND expires_at>?",
    )
      .bind(invitationResponse[1], user.id, now)
      .first<{ id: string; workspace_id: string; role: WorkspaceRole }>();
    if (!invitation)
      throw new ApiError(
        404,
        "INVITATION_UNAVAILABLE",
        "This invitation is no longer available.",
      );
    const accepted = invitationResponse[2] === "accept";
    if (accepted)
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=CASE WHEN workspace_memberships.role='owner' THEN 'owner' ELSE excluded.role END,updated_at=excluded.updated_at",
        ).bind(invitation.workspace_id, user.id, invitation.role, now, now),
        env.DB.prepare(
          "UPDATE workspace_invitations SET status='accepted',updated_at=? WHERE id=? AND status='pending'",
        ).bind(now, invitation.id),
      ]);
    else
      await env.DB.prepare(
        "UPDATE workspace_invitations SET status='declined',updated_at=? WHERE id=? AND invited_user_id=? AND status='pending'",
      )
        .bind(now, invitation.id, user.id)
        .run();
    await audit(
      env.DB,
      user.id,
      invitation.workspace_id,
      accepted ? "invitation_accepted" : "invitation_declined",
      "workspace_invitation",
      invitation.id,
    );
    return json({ data: { accepted } });
  }

  const workspace = await workspaceAccess(request, env.DB, user.id);
  assertWorkspacePermission(workspace.role, path, method);
  const repo = new BudgetRepository(env.DB, workspace.dataOwnerUserId);

  if (path === "/api/v1/workspace" && method === "GET")
    return json({
      data: {
        ...workspace,
        members: await env.DB.prepare(
          "SELECT u.id,u.username,m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role,u.username",
        )
          .bind(workspace.id)
          .all()
          .then((r) =>
            r.results.map((row) => toCamel(row as Record<string, unknown>)),
          ),
        invitations: await env.DB.prepare(
          "SELECT i.id,u.username,i.role,i.expires_at,i.created_at FROM workspace_invitations i JOIN users u ON u.id=i.invited_user_id WHERE i.workspace_id=? AND i.status='pending' AND i.expires_at>? ORDER BY i.created_at DESC",
        )
          .bind(workspace.id, new Date().toISOString())
          .all()
          .then((r) =>
            r.results.map((row) => toCamel(row as Record<string, unknown>)),
          ),
      },
    });
  if (path === "/api/v1/workspace/members" && method === "POST") {
    const body = assertObject(await readJson(request)),
      username = requireString(body, "username", 40),
      role = body.role;
    if (role !== "editor" && role !== "viewer")
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invite role must be editor or viewer.",
      );
    const invited = await env.DB.prepare(
      "SELECT id FROM users WHERE username_normalized=? AND active=1",
    )
      .bind(normalizeUsername(username))
      .first<{ id: string }>();
    const now = new Date(),
      expires = new Date(now);
    expires.setUTCDate(expires.getUTCDate() + 7);
    if (invited && invited.id !== user.id) {
      const membership = await env.DB.prepare(
        "SELECT 1 present FROM workspace_memberships WHERE workspace_id=? AND user_id=?",
      )
        .bind(workspace.id, invited.id)
        .first();
      if (!membership) {
        const existing = await env.DB.prepare(
          "SELECT id FROM workspace_invitations WHERE workspace_id=? AND invited_user_id=? AND status='pending'",
        )
          .bind(workspace.id, invited.id)
          .first<{ id: string }>();
        const invitationId = existing?.id ?? crypto.randomUUID();
        if (existing)
          await env.DB.prepare(
            "UPDATE workspace_invitations SET role=?,expires_at=?,updated_at=? WHERE id=?",
          )
            .bind(role, expires.toISOString(), now.toISOString(), invitationId)
            .run();
        else
          await env.DB.prepare(
            "INSERT INTO workspace_invitations(id,workspace_id,inviter_user_id,invited_user_id,role,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?)",
          )
            .bind(
              invitationId,
              workspace.id,
              user.id,
              invited.id,
              role,
              expires.toISOString(),
              now.toISOString(),
              now.toISOString(),
            )
            .run();
        await audit(
          env.DB,
          user.id,
          workspace.id,
          "invitation_sent",
          "workspace_invitation",
          invitationId,
        );
      }
    }
    return json(
      {
        data: {
          message:
            "If that username is eligible, an invitation will appear in their account.",
        },
      },
      202,
    );
  }
  const workspaceInvitationMatch = path.match(
    /^\/api\/v1\/workspace\/invitations\/([^/]+)(?:\/(resend))?$/,
  );
  if (workspaceInvitationMatch && method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE workspace_invitations SET status='cancelled',updated_at=? WHERE id=? AND workspace_id=? AND status='pending'",
    )
      .bind(new Date().toISOString(), workspaceInvitationMatch[1], workspace.id)
      .run();
    if (!result.meta.changes)
      throw new ApiError(404, "NOT_FOUND", "Pending invitation not found.");
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "invitation_cancelled",
      "workspace_invitation",
      workspaceInvitationMatch[1]!,
    );
    return new Response(null, { status: 204 });
  }
  if (workspaceInvitationMatch?.[2] === "resend" && method === "POST") {
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + 7);
    const result = await env.DB.prepare(
      "UPDATE workspace_invitations SET expires_at=?,updated_at=? WHERE id=? AND workspace_id=? AND status='pending'",
    )
      .bind(
        expires.toISOString(),
        new Date().toISOString(),
        workspaceInvitationMatch[1],
        workspace.id,
      )
      .run();
    if (!result.meta.changes)
      throw new ApiError(404, "NOT_FOUND", "Pending invitation not found.");
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "invitation_resent",
      "workspace_invitation",
      workspaceInvitationMatch[1]!,
    );
    return json({ data: { expiresAt: expires.toISOString() } });
  }
  const memberMatch = path.match(/^\/api\/v1\/workspace\/members\/([^/]+)$/);
  if (memberMatch && method === "PATCH") {
    const body = assertObject(await readJson(request)),
      role = body.role;
    if (role !== "editor" && role !== "viewer")
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Role must be editor or viewer.",
      );
    await env.DB.prepare(
      "UPDATE workspace_memberships SET role=?,updated_at=? WHERE workspace_id=? AND user_id=? AND role!='owner'",
    )
      .bind(role, new Date().toISOString(), workspace.id, memberMatch[1])
      .run();
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "member_role_updated",
      "user",
      memberMatch[1]!,
    );
    return json({ data: { userId: memberMatch[1], role } });
  }
  if (memberMatch && method === "DELETE") {
    await env.DB.prepare(
      "DELETE FROM workspace_memberships WHERE workspace_id=? AND user_id=? AND role!='owner'",
    )
      .bind(workspace.id, memberMatch[1])
      .run();
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "member_removed",
      "user",
      memberMatch[1]!,
    );
    return new Response(null, { status: 204 });
  }
  if (path === "/api/v1/archived-items" && method === "GET") {
    if (workspace.role !== "owner")
      throw new ApiError(
        403,
        "OWNER_REQUIRED",
        "Only the budget owner can manage archived items.",
      );
    const data = await repo.listArchivedItems();
    return json({
      data: {
        categories: data.categories.map((row) =>
          toCamel(row as Record<string, unknown>),
        ),
        masterCategories: data.masterCategories.map((row) =>
          toCamel(row as Record<string, unknown>),
        ),
      },
    });
  }
  const archivedMatch = path.match(
    /^\/api\/v1\/archived-items\/(category|master)\/([^/]+)$/,
  );
  if (archivedMatch && method === "POST") {
    if (workspace.role !== "owner")
      throw new ApiError(
        403,
        "OWNER_REQUIRED",
        "Only the budget owner can restore archived items.",
      );
    if (
      !(await repo.restoreArchived(
        archivedMatch[1] as "category" | "master",
        archivedMatch[2]!,
      ))
    )
      throw new ApiError(404, "NOT_FOUND", "Archived item not found.");
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "archived_item_restored",
      archivedMatch[1]!,
      archivedMatch[2]!,
    );
    return json({ data: { restored: true } });
  }
  if (archivedMatch && method === "DELETE") {
    if (workspace.role !== "owner")
      throw new ApiError(
        403,
        "OWNER_REQUIRED",
        "Only the budget owner can permanently delete archived items.",
      );
    const body = assertObject(await readJson(request));
    const replacementId =
      body.replacementId === null ? null : requireString(body, "replacementId");
    let found = false;
    try {
      found =
        archivedMatch[1] === "category"
          ? await repo.permanentlyDeleteCategory(
              archivedMatch[2]!,
              replacementId ?? "",
            )
          : await repo.permanentlyDeleteMaster(
              archivedMatch[2]!,
              replacementId,
            );
    } catch (error) {
      throw new ApiError(
        422,
        "INVALID_REASSIGNMENT",
        error instanceof Error ? error.message : "Invalid replacement.",
      );
    }
    if (!found)
      throw new ApiError(404, "NOT_FOUND", "Archived item not found.");
    await audit(
      env.DB,
      user.id,
      workspace.id,
      "archived_item_deleted",
      archivedMatch[1]!,
      archivedMatch[2]!,
    );
    return new Response(null, { status: 204 });
  }

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
  if (path === "/api/v1/transactions/selection" && method === "GET") {
    if (url.searchParams.has("startDate"))
      requireDate(url.searchParams.get("startDate"), "startDate");
    if (url.searchParams.has("endDate"))
      requireDate(url.searchParams.get("endDate"), "endDate");
    return json({ data: await repo.listTransactionIds(url.searchParams) });
  }
  if (path === "/api/v1/transactions/bulk" && method === "DELETE") {
    const body = assertObject(await readJson(request));
    if (
      !Array.isArray(body.ids) ||
      body.ids.length < 1 ||
      body.ids.length > 500 ||
      body.ids.some((id) => typeof id !== "string" || !id)
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "ids must contain between 1 and 500 transaction IDs.",
      );
    const ids = [...new Set(body.ids as string[])];
    if (ids.length !== body.ids.length)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Transaction IDs must not be repeated.",
      );
    const deleted = await repo.bulkDeleteTransactions(ids);
    if (deleted < 0)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "One or more selected transactions no longer exist.",
      );
    if (deleted !== ids.length)
      throw new ApiError(
        409,
        "BULK_DELETE_INCOMPLETE",
        "One or more selected transactions changed. Refresh and try again.",
      );
    return json({ data: { deleted } });
  }
  if (path === "/api/v1/transactions/bulk" && method === "PATCH") {
    const body = assertObject(await readJson(request));
    if (
      !Array.isArray(body.ids) ||
      body.ids.length < 1 ||
      body.ids.length > 500 ||
      body.ids.some((id) => typeof id !== "string" || !id)
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "ids must contain between 1 and 500 transaction IDs.",
      );
    const ids = [...new Set(body.ids as string[])];
    if (ids.length !== body.ids.length)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Transaction IDs must not be repeated.",
      );
    const changesBody = assertObject(body.changes),
      changes: {
        accountId?: string;
        categoryId?: string;
        transactionType?: TransactionType;
        transactionDirection?: "debit" | "credit";
      } = {};
    if (changesBody.accountId !== undefined)
      changes.accountId = requireString(changesBody, "accountId");
    if (changesBody.categoryId !== undefined)
      changes.categoryId = requireString(changesBody, "categoryId");
    if (changesBody.transactionType !== undefined) {
      const value = requireString(
        changesBody,
        "transactionType",
      ) as TransactionType;
      if (!TRANSACTION_TYPES.has(value))
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid transaction type.",
        );
      changes.transactionType = value;
    }
    if (changesBody.transactionDirection !== undefined) {
      const value = requireString(changesBody, "transactionDirection");
      if (value !== "debit" && value !== "credit")
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid transaction direction.",
        );
      changes.transactionDirection = value;
    }
    if (!Object.keys(changes).length)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Choose at least one field to change.",
      );
    for (const [table, id] of [
      ["accounts", changes.accountId],
      ["categories", changes.categoryId],
    ] as const) {
      if (!id) continue;
      const exists = await env.DB.prepare(
        `SELECT id FROM ${table} WHERE id=? AND user_id=? AND active=1`,
      )
        .bind(id, workspace.dataOwnerUserId)
        .first();
      if (!exists)
        throw new ApiError(
          422,
          "INVALID_REFERENCE",
          `The selected ${table.slice(0, -1)} does not exist or is archived.`,
        );
    }
    const updated = await repo.bulkUpdateTransactions(ids, changes);
    if (updated < 0)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "One or more selected transactions no longer exist.",
      );
    if (updated !== ids.length)
      throw new ApiError(
        409,
        "BULK_UPDATE_INCOMPLETE",
        "The selected transactions changed. Refresh and try again.",
      );
    return json({ data: { updated } });
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
        url.searchParams.get("accountId") ?? undefined,
      ),
    });
  }
  if (path === "/api/v1/cash-flow-trends" && method === "GET") {
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
    return json({ data: await repo.cashFlowTrend(startDate, endDate) });
  }

  if (path === "/api/v1/website-preferences" && method === "GET") {
    const record = await env.DB.prepare(
      "SELECT highlight_color,background_color,card_color,text_color,positive_color,negative_color,chart_accent_color FROM website_preferences WHERE user_id=?",
    )
      .bind(workspace.dataOwnerUserId)
      .first<Record<string, unknown>>();
    return json({ data: record ? toCamel(record) : null });
  }
  if (path === "/api/v1/website-preferences" && method === "PUT") {
    const body = assertObject(await readJson(request));
    const fields = [
      "highlightColor",
      "backgroundColor",
      "cardColor",
      "textColor",
      "positiveColor",
      "negativeColor",
      "chartAccentColor",
    ] as const;
    const colors = fields.map((field) => {
      const value = requireString(body, field, 7).toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value))
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          `${field} must be a six-digit hexadecimal color.`,
        );
      return value;
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO website_preferences (user_id,highlight_color,background_color,card_color,text_color,positive_color,negative_color,chart_accent_color,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET highlight_color=excluded.highlight_color,background_color=excluded.background_color,card_color=excluded.card_color,text_color=excluded.text_color,positive_color=excluded.positive_color,negative_color=excluded.negative_color,chart_accent_color=excluded.chart_accent_color,updated_at=excluded.updated_at",
    )
      .bind(workspace.dataOwnerUserId, ...colors, now)
      .run();
    return json({
      data: Object.fromEntries(
        fields.map((field, index) => [field, colors[index]]),
      ),
    });
  }

  const projectionRuleMatch = path.match(
    /^\/api\/v1\/projection-rules\/([^/]+)$/,
  );
  if (path === "/api/v1/projection-rules" && method === "GET")
    return json({
      data: (await repo.listProjectionRules()).map((row) => toCamel(row)),
    });
  if (
    (path === "/api/v1/projection-rules" && method === "POST") ||
    (projectionRuleMatch && method === "PUT")
  ) {
    const body = assertObject(await readJson(request)),
      description = requireString(body, "description"),
      ruleType = requireString(body, "ruleType") as ProjectionRuleType,
      frequency = requireString(body, "frequency") as ProjectionRuleFrequency,
      startDate = requireDate(
        typeof body.startDate === "string" ? body.startDate : null,
        "startDate",
      ),
      endDate =
        body.endDate === null ||
        body.endDate === "" ||
        body.endDate === undefined
          ? null
          : requireDate(String(body.endDate), "endDate");
    if (!PROJECTION_RULE_TYPES.has(ruleType))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid projection rule type.",
      );
    if (!PROJECTION_RULE_FREQUENCIES.has(frequency))
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid projection frequency.",
      );
    if (
      !Number.isSafeInteger(body.amountMinor) ||
      Number(body.amountMinor) <= 0
    )
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "amountMinor must be a positive integer number of cents.",
      );
    if (endDate && endDate < startDate)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "End date cannot be before start date.",
      );
    const fromAccountId =
        typeof body.fromAccountId === "string" && body.fromAccountId
          ? body.fromAccountId
          : null,
      toAccountId =
        typeof body.toAccountId === "string" && body.toAccountId
          ? body.toAccountId
          : null;
    const shapeValid =
      (ruleType === "income" && !fromAccountId && Boolean(toAccountId)) ||
      (ruleType === "expense" && Boolean(fromAccountId) && !toAccountId) ||
      (ruleType === "transfer" &&
        Boolean(fromAccountId) &&
        Boolean(toAccountId) &&
        fromAccountId !== toAccountId);
    if (!shapeValid)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Income needs a destination, expenses need a source, and transfers need different source and destination accounts.",
      );
    for (const accountId of [fromAccountId, toAccountId].filter(Boolean)) {
      const account = await env.DB.prepare(
        "SELECT id FROM accounts WHERE id=? AND user_id=? AND active=1",
      )
        .bind(accountId, workspace.dataOwnerUserId)
        .first();
      if (!account)
        throw new ApiError(
          422,
          "INVALID_ACCOUNT",
          "A selected account does not exist or is archived.",
        );
    }
    const input = {
      description,
      ruleType,
      amountMinor: Number(body.amountMinor),
      frequency,
      startDate,
      endDate,
      fromAccountId,
      toAccountId,
    };
    const record = projectionRuleMatch
      ? await repo.updateProjectionRule(projectionRuleMatch[1]!, input)
      : await repo.createProjectionRule(input);
    if (!record)
      throw new ApiError(404, "NOT_FOUND", "Projection rule not found.");
    return json(
      { data: toCamel(record as Record<string, unknown>) },
      projectionRuleMatch ? 200 : 201,
    );
  }
  if (projectionRuleMatch && method === "DELETE") {
    if (!(await repo.deleteProjectionRule(projectionRuleMatch[1]!)))
      throw new ApiError(404, "NOT_FOUND", "Projection rule not found.");
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
      .bind(workspace.dataOwnerUserId)
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
        name: String(item.name),
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
    const projectionRules: ProjectionRule[] = raw.projectionRules.map((row) => {
      const item = toCamel(row);
      return {
        id: String(item.id),
        description: String(item.description),
        ruleType: item.ruleType as ProjectionRuleType,
        amountMinor: Number(item.amountMinor),
        frequency: item.frequency as ProjectionRuleFrequency,
        startDate: String(item.startDate),
        endDate: item.endDate ? String(item.endDate) : null,
        fromAccountId: item.fromAccountId ? String(item.fromAccountId) : null,
        toAccountId: item.toAccountId ? String(item.toAccountId) : null,
      };
    });
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
          assumptions,
          startDate,
          endDate,
          today,
          projectionRules,
        ),
      },
    });
  }

  if (path === "/api/v1/balance-snapshots" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT s.*,a.name account_name,a.account_type FROM balance_snapshots s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.user_id=? ORDER BY snapshot_date,account_name",
    )
      .bind(workspace.dataOwnerUserId)
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
      .bind(accountId, workspace.dataOwnerUserId)
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
        workspace.dataOwnerUserId,
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
  const balanceSnapshotMatch = path.match(
    /^\/api\/v1\/balance-snapshots\/([^/]+)$/,
  );
  if (balanceSnapshotMatch && method === "PUT") {
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
    const account = await env.DB.prepare(
      "SELECT id FROM accounts WHERE id=? AND user_id=? AND active=1",
    )
      .bind(accountId, workspace.dataOwnerUserId)
      .first();
    if (!account)
      throw new ApiError(
        422,
        "INVALID_ACCOUNT",
        "The selected account does not exist or is archived.",
      );
    try {
      const result = await env.DB.prepare(
        "UPDATE balance_snapshots SET account_id=?,snapshot_date=?,balance_minor=?,note=?,updated_at=? WHERE id=? AND user_id=?",
      )
        .bind(
          accountId,
          snapshotDate,
          body.balanceMinor,
          typeof body.note === "string" ? body.note.slice(0, 500) : "",
          new Date().toISOString(),
          balanceSnapshotMatch[1],
          workspace.dataOwnerUserId,
        )
        .run();
      if (!result.meta.changes)
        throw new ApiError(404, "NOT_FOUND", "Account balance not found.");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        409,
        "BALANCE_DATE_CONFLICT",
        "That account already has a balance recorded for this date.",
      );
    }
    const updated = await env.DB.prepare(
      "SELECT s.*,a.name account_name,a.account_type FROM balance_snapshots s JOIN accounts a ON a.id=s.account_id AND a.user_id=s.user_id WHERE s.id=? AND s.user_id=?",
    )
      .bind(balanceSnapshotMatch[1], workspace.dataOwnerUserId)
      .first();
    return json({ data: toCamel(updated as Record<string, unknown>) });
  }
  if (balanceSnapshotMatch && method === "DELETE") {
    const result = await env.DB.prepare(
      "DELETE FROM balance_snapshots WHERE id=? AND user_id=?",
    )
      .bind(balanceSnapshotMatch[1], workspace.dataOwnerUserId)
      .run();
    if (!result.meta.changes)
      throw new ApiError(404, "NOT_FOUND", "Account balance not found.");
    return new Response(null, { status: 204 });
  }

  if (path === "/api/v1/projection" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT * FROM projection_assumptions WHERE user_id=?",
    )
      .bind(workspace.dataOwnerUserId)
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
      .bind(workspace.dataOwnerUserId, workspace.dataOwnerUserId)
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
        workspace.dataOwnerUserId,
      )
      .run();
    return json({ data: body });
  }

  if (path === "/api/v1/imports" && method === "POST") {
    const body = assertObject(await readJson(request));
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "rows must contain 1–40 transactions.",
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
    const refundCategories = new Map<number, string>();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const candidate = raw as Record<string, unknown>;
      if (
        candidate.transactionType === "expense" &&
        candidate.transactionDirection === "debit" &&
        Number.isSafeInteger(candidate.amountMinor) &&
        typeof candidate.categoryId === "string"
      )
        refundCategories.set(
          Number(candidate.amountMinor),
          candidate.categoryId,
        );
    }
    const incomingAmounts = [
      ...new Set(
        rows
          .filter(
            (raw): raw is Record<string, unknown> =>
              Boolean(raw) && typeof raw === "object" && !Array.isArray(raw),
          )
          .filter(
            (candidate) =>
              candidate.transactionType === "income" &&
              candidate.transactionDirection === "credit" &&
              Number.isSafeInteger(candidate.amountMinor),
          )
          .map((candidate) => Number(candidate.amountMinor)),
      ),
    ];
    if (incomingAmounts.length) {
      const placeholders = incomingAmounts.map(() => "?").join(",");
      const matches = await env.DB.prepare(
        `SELECT amount_minor,category_id FROM transactions WHERE user_id=? AND account_id=? AND transaction_type='expense' AND amount_minor IN (${placeholders}) ORDER BY transaction_date DESC`,
      )
        .bind(workspace.dataOwnerUserId, accountId, ...incomingAmounts)
        .all<{ amount_minor: number; category_id: string }>();
      for (const match of matches.results)
        if (!refundCategories.has(match.amount_minor))
          refundCategories.set(match.amount_minor, match.category_id);
    }
    for (const [index, raw] of rows.entries()) {
      const candidate = assertObject(raw);
      candidate.accountId = accountId;
      const refundCategory = refundCategories.get(
        Number(candidate.amountMinor),
      );
      if (
        refundCategory &&
        candidate.transactionType === "income" &&
        candidate.transactionDirection === "credit"
      ) {
        candidate.transactionType = "refund";
        candidate.categoryId = refundCategory;
      }
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
      const sourceRow =
          typeof candidate.sourceRow === "string"
            ? candidate.sourceRow.slice(0, 10_000)
            : JSON.stringify(raw),
        sourceTransactionId =
          typeof candidate.sourceTransactionId === "string"
            ? candidate.sourceTransactionId.slice(0, 300)
            : undefined,
        postedDate =
          typeof candidate.postedDate === "string"
            ? candidate.postedDate.slice(0, 10)
            : undefined,
        occurrenceNumber =
          Number.isSafeInteger(candidate.occurrenceNumber) &&
          Number(candidate.occurrenceNumber) > 0
            ? Number(candidate.occurrenceNumber)
            : index + 1,
        normalized = importFingerprintSource({
          accountId,
          transactionDate: validation.data.transactionDate,
          postedDate,
          sourceTransactionId,
          sourceRow,
          vendorName:
            typeof candidate.vendorName === "string"
              ? candidate.vendorName
              : validation.data.vendorName,
          amountMinor: validation.data.amountMinor,
          transactionType: validation.data.transactionType,
          transactionDirection: validation.data.transactionDirection,
          occurrenceNumber,
        });
      validation.data.importFingerprint = await sha256(normalized);
      const id = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO transactions (id,user_id,transaction_date,category_id,account_id,vendor_name,description,amount_minor,transaction_type,transaction_direction,currency,import_id,import_fingerprint,balance_effect_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          workspace.dataOwnerUserId,
          validation.data.transactionDate,
          validation.data.categoryId,
          accountId,
          validation.data.vendorName,
          validation.data.description ?? "",
          validation.data.amountMinor,
          validation.data.transactionType,
          validation.data.transactionDirection,
          env.BASE_CURRENCY,
          importId,
          validation.data.importFingerprint,
          validation.data.balanceEffectMinor ??
            (validation.data.transactionDirection === "credit"
              ? validation.data.amountMinor
              : -validation.data.amountMinor),
          now,
          now,
        ),
      );
    }
    await env.DB.prepare(
      "INSERT INTO imports (id,user_id,file_name,account_id,row_count,imported_count,duplicate_count,rejected_count,created_at) VALUES (?,?,?,?,?,0,0,0,?)",
    )
      .bind(
        importId,
        workspace.dataOwnerUserId,
        fileName,
        accountId,
        rows.length,
        now,
      )
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
      .bind(accepted, duplicates, rejected, importId, workspace.dataOwnerUserId)
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
