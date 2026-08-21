"use client";

import { getPlatform } from "./platform";

// API-клиент (phase-2-plan §5, B11): мгновенный UI-отклик, наблюдение
// состояния; CSRF-токен держится в памяти модуля, не в storage.

let csrfToken: string | null = null;

export interface MeResponse {
  language: "RU" | "EN";
  onboardingCompleted: boolean;
  entitlement: {
    level: "DEMO" | "ARI_CORE";
    demoUsed: number;
    demoLimit: number;
    priceStars: number;
  };
  unreadCount: number;
  csrfToken: string;
}

// Single-flight: конкурентные вызовы (AppProvider + onboarding + retry
// из request) делят ОДНУ аутентификацию. Иначе ротация сессий на сервере
// обесценивает cookie/CSRF первого запроса вторым — гонка, ловившаяся
// e2e как «Skip зацикливает onboarding».
let authInFlight: Promise<{ onboardingCompleted: boolean } | null> | null = null;

export function authenticate(): Promise<{ onboardingCompleted: boolean } | null> {
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    try {
      const platform = getPlatform();
      const initData = platform.getInitData();
      const body = initData ? { initData } : { dev: true };
      const res = await fetch("/api/auth/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        csrfToken: string;
        onboardingCompleted: boolean;
      };
      csrfToken = data.csrfToken;
      return { onboardingCompleted: data.onboardingCompleted };
    } finally {
      authInFlight = null;
    }
  })();
  return authInFlight;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-Atlas-CSRF": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    // Сессия истекла — тихая переаутентификация через initData и один повтор.
    const re = await authenticate();
    if (re) {
      return request<T>(path, init);
    }
  }
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function getMe(): Promise<MeResponse> {
  const me = await request<MeResponse>("/api/me");
  csrfToken = me.csrfToken;
  return me;
}

export interface InterpretationView {
  id: string;
  status: "READY" | "NEEDS_CLARIFICATION" | "OUT_OF_SCOPE" | "INVALID";
  attempt: number;
  route: string;
  adjustment: "NONE" | "PROJECT_UNRESOLVED" | "PROJECT_AMBIGUOUS";
  clarificationQuestion: string | null;
  provisionalTask: string | null;
  quickAnswer: string | null;
  understood: {
    summary: string;
    researchTask: string;
    projectSlug: string | null;
    projectOrAsset: string | null;
    taskType: string | null;
    assumptions: string[];
  } | null;
}

export interface GateView {
  scope: "SUPPORTED" | "OUT_OF_SCOPE";
  entitlement: "OK" | "CORE_REQUIRED";
  research:
    | "AVAILABLE"
    | "DISABLED"
    | "NOT_DEEP_RESEARCH"
    | "OUT_OF_SCOPE"
    | "CORE_REQUIRED"
    | "ACTIVE_JOB_EXISTS"
    | "DEMO_QUOTA_EXHAUSTED";
  demo: { used: number; limit: number } | null;
}

export interface InterpretResult {
  interpretation: InterpretationView;
  gates: GateView;
}

// Код ошибки сервера — отдельно от сетевого сбоя: UI обязан различать
// «лимит уточнений» и «сервис недоступен».
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function requestChecked<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-Atlas-CSRF": csrfToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    const re = await authenticate();
    if (re) return requestChecked<T>(path, init);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "UNKNOWN");
  }
  return (await res.json()) as T;
}

export const api = {
  interpret: (question: string) =>
    requestChecked<InterpretResult>("/api/interpretations", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  clarify: (id: string, answer: string) =>
    requestChecked<InterpretResult>(`/api/interpretations/${id}/clarify`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),
  startResearch: (interpretationId: string, idempotencyKey: string) =>
    requestChecked<{ job: { id: string; state: string } }>("/api/research-jobs", {
      method: "POST",
      body: JSON.stringify({ interpretationId, idempotencyKey }),
    }),
  setLanguage: (language: "RU" | "EN") =>
    request<{ language: string }>("/api/me/language", {
      method: "PATCH",
      body: JSON.stringify({ language }),
    }),
  completeOnboarding: () =>
    request<{ onboardingCompleted: boolean }>("/api/me/onboarding", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  getProjects: () =>
    request<{
      projects: { slug: string; name: string; ticker: string | null; researchable: boolean }[];
    }>("/api/projects"),
  getResearchJobs: () =>
    request<{
      jobs: {
        id: string;
        state: string;
        progressStage: number;
        originalQuestion: string;
        unread: boolean;
        createdAt: string;
        finishedAt: string | null;
      }[];
    }>("/api/research-jobs"),
  markRead: (id: string) =>
    request<{ read: true }>(`/api/research-jobs/${id}/read`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  cancelJob: (id: string) =>
    request<{ cancelled: true; already?: boolean }>(
      `/api/research-jobs/${id}/cancel`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  deleteAccount: () =>
    request<{ deleted: true }>("/api/me", { method: "DELETE" }),
};
