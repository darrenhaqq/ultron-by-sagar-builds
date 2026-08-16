const DEFAULT_REMOTE_CORE_URL =
  "https://ultron-by-sagar-builds.recouvr-saas.workers.dev";

export const JARVIS_CORE_URL =
  process.env.NEXT_PUBLIC_JARVIS_CORE_URL?.trim() || DEFAULT_REMOTE_CORE_URL;

const SESSION_KEY = "jarvis.owner.session.v1";

export type JarvisSessionStatus = {
  configured: boolean;
  authenticated: boolean;
};

export function getJarvisSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function clearJarvisSessionToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}

function authorizationHeaders(): HeadersInit {
  const token = getJarvisSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function getJarvisSessionStatus(): Promise<JarvisSessionStatus> {
  try {
    const response = await fetch(`${JARVIS_CORE_URL}/v1/auth/status`, {
      headers: authorizationHeaders(),
      cache: "no-store",
    });

    if (response.status === 401) {
      clearJarvisSessionToken();
      return { configured: true, authenticated: false };
    }

    if (!response.ok) return { configured: false, authenticated: false };
    const payload = (await response.json()) as Partial<JarvisSessionStatus>;
    return {
      configured: Boolean(payload.configured),
      authenticated: Boolean(payload.authenticated),
    };
  } catch {
    return { configured: false, authenticated: false };
  }
}

export async function loginJarvis(password: string): Promise<void> {
  const response = await fetch(`${JARVIS_CORE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    error?: unknown;
  };

  if (!response.ok || typeof payload.token !== "string") {
    const code = typeof payload.error === "string" ? payload.error : "AUTH_FAILED";
    throw new Error(code);
  }

  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, payload.token);
  }
}

export async function logoutJarvis(): Promise<void> {
  const token = getJarvisSessionToken();
  clearJarvisSessionToken();
  if (!token) return;

  try {
    await fetch(`${JARVIS_CORE_URL}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Local logout is authoritative for the client; server expiry is a fallback.
  }
}
