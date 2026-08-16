import { ensureSchema, type DbEnv } from "./db";

export type AuthEnv = DbEnv & {
  JARVIS_OWNER_PASSWORD?: string;
};

export type JarvisIdentity = {
  id: "owner";
};

export type AuthResult =
  | { ok: true; identity: JarvisIdentity }
  | { ok: false; status: 401 | 429 | 503; code: string };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function clientKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const userAgent = (request.headers.get("user-agent") || "unknown").slice(0, 120);
  return sha256(`${ip}|${userAgent}`);
}

export function authConfigured(env: AuthEnv): boolean {
  return Boolean(env.DB && env.JARVIS_OWNER_PASSWORD?.trim());
}

export async function login(
  request: Request,
  env: AuthEnv,
  password: string,
): Promise<
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 401 | 429 | 503; code: string }
> {
  if (!authConfigured(env)) {
    return { ok: false, status: 503, code: "IDENTITY_NOT_CONFIGURED" };
  }

  const db = await ensureSchema(env);
  const key = await clientKey(request);
  const now = Date.now();
  const attempt = await db
    .prepare("SELECT attempts, window_start FROM jarvis_auth_attempts WHERE client_key = ?")
    .bind(key)
    .first<{ attempts: number; window_start: number }>();

  if (
    attempt &&
    now - Number(attempt.window_start) < LOGIN_WINDOW_MS &&
    Number(attempt.attempts) >= LOGIN_MAX_ATTEMPTS
  ) {
    return { ok: false, status: 429, code: "AUTH_RATE_LIMITED" };
  }

  const matches = await passwordMatches(password, env.JARVIS_OWNER_PASSWORD!.trim());
  if (!matches) {
    if (!attempt || now - Number(attempt.window_start) >= LOGIN_WINDOW_MS) {
      await db
        .prepare(
          "INSERT INTO jarvis_auth_attempts (client_key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(client_key) DO UPDATE SET attempts = 1, window_start = excluded.window_start",
        )
        .bind(key, now)
        .run();
    } else {
      await db
        .prepare("UPDATE jarvis_auth_attempts SET attempts = attempts + 1 WHERE client_key = ?")
        .bind(key)
        .run();
    }
    return { ok: false, status: 401, code: "AUTH_INVALID" };
  }

  await db.prepare("DELETE FROM jarvis_auth_attempts WHERE client_key = ?").bind(key).run();
  await db.prepare("DELETE FROM jarvis_sessions WHERE expires_at <= ?").bind(now).run();

  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare("INSERT INTO jarvis_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, now, expiresAt)
    .run();

  return { ok: true, token, expiresAt };
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<AuthResult> {
  if (!authConfigured(env)) {
    return { ok: false, status: 503, code: "IDENTITY_NOT_CONFIGURED" };
  }

  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, code: "AUTH_REQUIRED" };

  const db = await ensureSchema(env);
  const tokenHash = await sha256(token);
  const session = await db
    .prepare("SELECT expires_at FROM jarvis_sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ expires_at: number }>();

  if (!session) return { ok: false, status: 401, code: "AUTH_INVALID" };

  if (Number(session.expires_at) <= Date.now()) {
    await db.prepare("DELETE FROM jarvis_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return { ok: false, status: 401, code: "AUTH_EXPIRED" };
  }

  return { ok: true, identity: { id: "owner" } };
}

export async function authenticateOptional(
  request: Request,
  env: AuthEnv,
): Promise<
  | { ok: true; identity: JarvisIdentity | null }
  | { ok: false; status: 401 | 429 | 503; code: string }
> {
  if (!bearerToken(request)) return { ok: true, identity: null };
  const result = await authenticate(request, env);
  if (!result.ok) return result;
  return { ok: true, identity: result.identity };
}

export async function logout(request: Request, env: AuthEnv): Promise<void> {
  const token = bearerToken(request);
  if (!token || !env.DB) return;
  const db = await ensureSchema(env);
  const tokenHash = await sha256(token);
  await db.prepare("DELETE FROM jarvis_sessions WHERE token_hash = ?").bind(tokenHash).run();
}
