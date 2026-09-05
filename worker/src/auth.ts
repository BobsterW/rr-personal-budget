/*
 * AUTHENTICATION AND SESSION BOUNDARY
 * Passwords are one-way hashed with bcrypt. Raw random session tokens are sent
 * only in HttpOnly cookies; D1 stores a SHA-256 digest for session lookup.
 */
import bcrypt from "bcryptjs";
import { ApiError, readJson } from "./http";

export interface AuthUser {
  id: string;
  username: string;
}

const SESSION_COOKIE = "rr_session";
const SESSION_DAYS = 14;
const IDLE_MINUTES = 10;
const PAGE_SESSION_HEADER = "x-page-session";
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

// Generate 256 random bits and encode them as URL-safe base64.
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

// Normalization makes case/Unicode variants resolve to one login identity.
export function normalizeUsername(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function validateUsername(value: unknown): string {
  if (typeof value !== "string")
    throw new ApiError(422, "VALIDATION_ERROR", "Username is required.");
  const username = value.trim().normalize("NFKC");
  if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Username must be 3–40 characters and use letters, numbers, periods, underscores, or hyphens.",
    );
  return username;
}

// Bcrypt accepts at most 72 bytes, so reject longer input instead of truncating.
export function validatePassword(value: unknown): string {
  if (typeof value !== "string")
    throw new ApiError(422, "VALIDATION_ERROR", "Password is required.");
  if (encoder.encode(value).byteLength > 72)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Password must be no more than 72 UTF-8 bytes.",
    );
  if (
    value.length < 8 ||
    !/[A-Z]/.test(value) ||
    !/[0-9]/.test(value) ||
    !/[^\p{L}\p{N}\s]/u.test(value)
  )
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Password must have at least 8 characters, one capital letter, one number, and one special character.",
    );
  return value;
}

export async function passwordHash(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function passwordMatches(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Resolve the request cookie to an active user through an unexpired session.
export async function requireUser(
  request: Request,
  db: D1Database,
): Promise<AuthUser> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token)
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Please sign in.");
  const tokenHash = await digest(token);
  const row = await db
    .prepare(
      "SELECT u.id,u.username,s.persistent,s.page_key_hash,s.last_used_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.active=1",
    )
    .bind(tokenHash)
    .first<
      AuthUser & {
        persistent: number;
        page_key_hash: string | null;
        last_used_at: string;
        expires_at: string;
      }
    >();
  const now = new Date();
  if (!row || row.expires_at <= now.toISOString()) {
    if (row)
      await db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(tokenHash)
        .run();
    throw new ApiError(
      401,
      "SESSION_EXPIRED",
      "Your session expired. Please sign in again.",
    );
  }
  if (!row.persistent) {
    const idleCutoff = new Date(
      now.getTime() - IDLE_MINUTES * 60_000,
    ).toISOString();
    const pageKey = request.headers.get(PAGE_SESSION_HEADER);
    if (row.last_used_at <= idleCutoff) {
      await db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(tokenHash)
        .run();
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "Your session expired after 10 minutes of inactivity. Please sign in again.",
      );
    }
    if (
      !pageKey ||
      !row.page_key_hash ||
      !timingSafeTextEqual(await digest(pageKey), row.page_key_hash)
    )
      throw new ApiError(
        401,
        "PAGE_SESSION_ENDED",
        "This page session ended. Please sign in again.",
      );
    await db
      .prepare("UPDATE sessions SET last_used_at=? WHERE token_hash=?")
      .bind(now.toISOString(), tokenHash)
      .run();
  }
  return { id: row.id, username: row.username };
}

// Persist only a token digest and return the raw secret in a protected cookie.
export async function createSession(
  userId: string,
  db: D1Database,
  request: Request,
  persistent = false,
): Promise<{ cookie: string; pageSessionKey: string | null }> {
  const token = randomToken();
  const pageSessionKey = persistent ? null : randomToken();
  const now = new Date();
  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + SESSION_DAYS);
  await db
    .prepare(
      "INSERT INTO sessions (id,user_id,token_hash,created_at,last_used_at,expires_at,persistent,page_key_hash) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      userId,
      await digest(token),
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
      persistent ? 1 : 0,
      pageSessionKey ? await digest(pageSessionKey) : null,
    )
    .run();
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const crossSite = origin
    ? new URL(origin).hostname !== requestUrl.hostname
    : false;
  const secure = requestUrl.protocol === "https:" ? "; Secure" : "";
  const longevity = persistent ? `; Max-Age=${SESSION_DAYS * 86400}` : "";
  return {
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=${crossSite ? "None" : "Strict"}${longevity}`,
    pageSessionKey,
  };
}

export async function destroySession(
  request: Request,
  db: D1Database,
): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token)
    await db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await digest(token))
      .run();
}

export function clearSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`;
}

export async function credentials(
  request: Request,
): Promise<{ username: string; password: string; keepSignedIn: boolean }> {
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "VALIDATION_ERROR", "A JSON object is required.");
  const record = body as Record<string, unknown>;
  return {
    username: validateUsername(record.username),
    password: typeof record.password === "string" ? record.password : "",
    keepSignedIn: record.keepSignedIn === true,
  };
}
