import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as authPOST } from "../app/api/auth/telegram/route";
import { __resetRuntime } from "../src/server/runtime";
import { setupTestDatabase, type TestContext } from "./phase1-setup";

// The desktop owner path begins here, and this is where it silently broke.
//
// A browser outside Telegram has no initData, so src/client/api.ts posts
// { dev: true }. That body is only servable by the dev bypass. With
// AUTH_DEV_BYPASS unset the request fell through to real Telegram
// authentication, which called getEnv("BOT_TOKEN"), threw, and surfaced as
// a generic 500 INTERNAL. Every later call was then 401 and the UI said
// only "не удалось обработать вопрос" — so a one-line environment gap
// presented as an application bug, and cost a manual debugging round.
//
// These tests pin BOTH halves of that: the bypass works when enabled, and
// when it is NOT enabled the failure names its own cause instead of
// blaming a Telegram bot token the desktop path never needed.

const ORIGIN = "https://app.atlas.test";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  ctx = await setupTestDatabase();
  await __resetRuntime();
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function devAuthRequest(): Request {
  return new Request("http://localhost/api/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ dev: true }),
  });
}

describe("/api/auth/telegram — desktop dev bypass", () => {
  it("development + AUTH_DEV_BYPASS=1 + {dev:true} → real session, the owner can actually sign in", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_DEV_BYPASS", "1");

    const res = await authPOST(devAuthRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { csrfToken: string; onboardingCompleted: boolean };
    expect(body.csrfToken).toBeTruthy();
    // A usable session cookie, not just a 200 — this is what every
    // subsequent /api/* call depends on.
    expect(res.headers.get("Set-Cookie")).toContain("atlas_session=");
  });

  it("development + {dev:true} WITHOUT the flag → names the real prerequisite, not a misleading BOT_TOKEN 500", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_DEV_BYPASS", undefined);
    vi.stubEnv("BOT_TOKEN", undefined);

    const res = await authPOST(devAuthRequest());
    const body = (await res.json()) as { error: string };

    // The regression itself: this used to be 500 / "INTERNAL".
    expect(res.status).toBe(503);
    expect(body.error).toBe("AUTH_DEV_BYPASS_DISABLED");
    expect(body.error).not.toBe("INTERNAL");
    // And still no session — a clearer error must never mean a weaker one.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("the clearer error does NOT appear in a production build, and {dev:true} never bypasses there", async () => {
    // Security boundary: the branch that improves the message is
    // development-only. In production a {dev:true} body must still fall
    // through to real Telegram authentication and fail there.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DEV_BYPASS", undefined);
    vi.stubEnv("BOT_TOKEN", undefined);

    const res = await authPOST(devAuthRequest());
    expect(res.status).not.toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("AUTH_DEV_BYPASS_DISABLED");
  });

  it("AUTH_DEV_BYPASS=1 is INERT in a production build — the flag alone can never mint a session", async () => {
    // The one that actually matters if this flag ever leaks into a
    // deployed environment: NODE_ENV is the hard gate, not the flag.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DEV_BYPASS", "1");
    vi.stubEnv("BOT_TOKEN", undefined);

    const res = await authPOST(devAuthRequest());
    expect(res.status).not.toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});
