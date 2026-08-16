export type AuthEnv = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
};

export type JarvisIdentity = {
  id: string;
  email?: string;
  accessToken: string;
};

export type AuthResult =
  | { ok: true; identity: JarvisIdentity }
  | { ok: false; status: 401 | 503; code: string };

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

export function authConfigured(env: AuthEnv): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_PUBLISHABLE_KEY?.trim());
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

  try {
    const response = await fetch(`${env.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY!,
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { ok: false, status: 401, code: "AUTH_INVALID" };
    }

    const user = (await response.json()) as { id?: unknown; email?: unknown };
    if (typeof user.id !== "string" || !user.id) {
      return { ok: false, status: 401, code: "AUTH_INVALID" };
    }

    return {
      ok: true,
      identity: {
        id: user.id,
        email: typeof user.email === "string" ? user.email : undefined,
        accessToken: token,
      },
    };
  } catch {
    return { ok: false, status: 503, code: "IDENTITY_UNAVAILABLE" };
  }
}
