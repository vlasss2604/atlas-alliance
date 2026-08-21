import type { Database } from "../db/client";
import { CSRF_HEADER, verifyCsrfToken } from "./csrf";
import { findSession, SESSION_COOKIE, type SessionInfo } from "./session";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function allowedOrigins(): string[] {
  return getEnv("ALLOWED_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Origin/Referer allowlist — только собственные frontend-origins (§3.1).
// Отсутствующий или чужой Origin на state-changing запросе → 403.
export function requireAllowedOrigin(req: Request): void {
  const origin =
    req.headers.get("origin") ??
    (() => {
      const referer = req.headers.get("referer");
      if (!referer) return null;
      try {
        return new URL(referer).origin;
      } catch {
        return null;
      }
    })();
  if (!origin || !allowedOrigins().includes(origin)) {
    throw new HttpError(403, "FORBIDDEN_ORIGIN");
  }
}

// Невалидный UUID в path → 404 (а не 500 из БД): неизвестный и
// синтаксически невозможный id неразличимы для клиента.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new HttpError(404, "NOT_FOUND");
  return value;
}

export function readSessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export async function requireSession(
  db: Database,
  req: Request,
): Promise<SessionInfo> {
  const token = readSessionToken(req);
  if (!token) throw new HttpError(401, "UNAUTHENTICATED");
  const session = await findSession(db, token);
  if (!session) throw new HttpError(401, "UNAUTHENTICATED");
  return session;
}

export function requireCsrf(req: Request, session: SessionInfo): void {
  const provided = req.headers.get(CSRF_HEADER);
  if (!verifyCsrfToken(provided, session.tokenHash, getEnv("CSRF_SECRET"))) {
    throw new HttpError(403, "CSRF_FAILED");
  }
}

export function requireRole(session: SessionInfo, role: "ADMIN"): void {
  if (session.role !== role) throw new HttpError(403, "FORBIDDEN");
}

// Полный набор для authenticated state-changing endpoints (§3.1):
// сессия + CSRF + Origin, ни одно не заменяет другое.
export async function requireMutation(
  db: Database,
  req: Request,
): Promise<SessionInfo> {
  requireAllowedOrigin(req);
  const session = await requireSession(db, req);
  requireCsrf(req, session);
  return session;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: e.code }, { status: e.status });
  }
  console.error("[api]", e instanceof Error ? e.message : e);
  return Response.json({ error: "INTERNAL" }, { status: 500 });
}
