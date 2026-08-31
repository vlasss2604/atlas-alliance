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

export interface ResearchEvidenceView {
  id: string;
  patternStep: number | null;
  component: string | null;
  relationship: string;
  directness: string | null;
  fragment: string;
  summary: string | null;
  doesNotProve: string | null;
  mechanismState: string | null;
  valueSource: string | null;
  sourceClass: string | null;
  officiality: string | null;
  observedAt: string | null;
  dataAsOf: string | null;
  publishedAt: string | null;
  retrievedUrl: string;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceType: string;
}

// UI V1 — one row of the job list. Everything a Recent Proof card renders
// comes from here, so a list never has to fetch N details and never has to
// guess a value it was not given: `verdict` is null when no Proof exists,
// and that is displayed as "no verdict", never as one.
export interface ResearchJobListItem {
  id: string;
  state: string;
  progressStage: number;
  memoryStatus: string;
  // The engine's own persisted acquisition phase. Authoritative for live
  // progress; null before acquisition starts.
  acquisitionPhase: "SEARCHING" | "FETCHING" | "EXTRACTING" | null;
  acquisitionPhaseAt: string | null;
  terminationReason: string | null;
  originalQuestion: string;
  unread: boolean;
  createdAt: string;
  finishedAt: string | null;
  projectName: string | null;
  projectSlug: string | null;
  projectTicker: string | null;
  verdict: string | null;
}

// S9's client-facing Proof, exactly as services/proof-view.ts serializes it.
// The route has always returned this; the client type simply stopped
// declaring it, so the screens could not read the canonical answer and read
// engine internals instead.
export interface ProofCitationView {
  evidenceId: string;
  patternStep: number | null;
  component: string | null;
  relationship: string;
  directness: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  mechanismState: string | null;
  sourceClass: string | null;
  officiality: string | null;
  entityBinding: string | null;
  publishedAt: string | null;
  retrievedUrl: string;
  source: { title: string | null; publisher: string | null; sourceType: string };
}

export interface ProofView {
  proofId: string;
  researchJobId: string;
  projectId: string;
  topicId: string;
  verdict: string;
  // `band` is the semantic value; `score` is its encoding and is NEVER a
  // percentage or a probability. Nothing may render it with a "%".
  confidence: { band: string | null; score: number };
  verificationStatus: string;
  visibility: string;
  layers: unknown;
  citations: ProofCitationView[];
  researchCutoff: string | null;
  createdAt: string;
}

export interface ResearchJobDetail {
  job: {
    id: string;
    state: string;
    progressStage: number;
    memoryStatus: string;
    acquisitionPhase: "SEARCHING" | "FETCHING" | "EXTRACTING" | null;
    acquisitionPhaseAt: string | null;
    projectName: string | null;
    projectSlug: string | null;
    projectTicker: string | null;
    originalQuestion: string;
    terminationReason: string | null;
    errorCode: string | null;
    origin: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  // Null means "no Proof exists for this job" — still running, or finished
  // without one. Never fabricated on a read.
  proof: ProofView | null;
  claimSupport: {
    intent: string;
    status: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "NOT_SUPPORTED" | "INSUFFICIENT_EVIDENCE";
    reasonCodes: unknown[];
    requirementResults: unknown[];
    contextGaps: unknown[];
  } | null;
  mechanism: {
    flows: unknown[];
    unassignedGaps: unknown[];
  } | null;
  // Authoritative execution counts. attemptedSteps is the number of
  // distinct Pattern steps the controller actually attempted — NOT
  // mechanism.flows.length, which counts mechanism branches and reported
  // "1 step" for a job that attempted all eight.
  execution: {
    attemptedSteps: number;
    attemptedComponents: number;
    succeededComponents: number;
    establishedComponents: number;
  };
  // The ONLY valid source for the Proof evidence section: evidence
  // structurally linked to the displayed claim by S7 provenance / S5
  // component results. `evidence` below is the whole job and must never
  // be rendered as this finding's proof.
  finding: {
    componentKeys: { step: number; component: string }[];
    supporting: ResearchEvidenceView[];
    contradicting: ResearchEvidenceView[];
    excluded: (ResearchEvidenceView & { exclusionReason: string })[];
  };
  components: {
    patternStep: number;
    component: string;
    status: string;
    reasonCodes: unknown[];
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
    excludedEvidence: { evidenceId: string; reason: string }[];
  }[];
  evidence: (ResearchEvidenceView & {
    links: {
      patternStep: number;
      component: string;
      role: "SUPPORTING" | "CONTRADICTING" | "EXCLUDED";
      exclusionReason: string | null;
    }[];
  })[];
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
  getResearchJobs: () => request<{ jobs: ResearchJobListItem[] }>("/api/research-jobs"),
  getResearchJob: (id: string) =>
    requestChecked<ResearchJobDetail>(`/api/research-jobs/${id}`, {
      method: "GET",
    }),
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
