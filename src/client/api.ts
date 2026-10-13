"use client";

import { getPlatform } from "./platform";
import type { ComponentCoverage } from "./research-model";

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
  // Research Memory is consulted during a run only when this is true.
  memoryEnabled: boolean;
  // D-170: present only while private beta is what admits this user. The
  // server's own count (D-169 rule); the client never recomputes it.
  privateBeta: { used: number; limit: number; remaining: number } | null;
  // D-170: the one-time feedback prompt is due (second Proof, never asked).
  feedbackDue: boolean;
  csrfToken: string;
}

export type FeedbackKeepUsing = "YES" | "NO" | "UNSURE";
export type BetaFeedbackInput =
  | { action: "DISMISS" }
  | { action: "SUBMIT"; useful: string; missing: string; keepUsing: FeedbackKeepUsing; changeNeeded: string };

// Single-flight: конкурентные вызовы (AppProvider + onboarding + retry
// из request) делят ОДНУ аутентификацию. Иначе ротация сессий на сервере
// обесценивает cookie/CSRF первого запроса вторым — гонка, ловившаяся
// e2e как «Skip зацикливает onboarding».
let authInFlight: Promise<AuthView | null> | null = null;

export interface AuthView {
  onboardingCompleted: boolean;
  // Opaque Mini App launch parameter from the signed initData, or null.
  startParam: string | null;
}

export function authenticate(): Promise<AuthView | null> {
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
        startParam?: string | null;
      };
      csrfToken = data.csrfToken;
      return { onboardingCompleted: data.onboardingCompleted, startParam: data.startParam ?? null };
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
    | "DEMO_QUOTA_EXHAUSTED"
    | "BETA_ACCESS_REQUIRED"
    | "BETA_PROJECT_NOT_AVAILABLE"
    | "BETA_RESEARCH_LIMIT_REACHED"
    | "GLOBAL_BETA_CAPACITY_REACHED";
  demo: { used: number; limit: number } | null;
}

export interface InterpretResult {
  interpretation: InterpretationView;
  gates: GateView;
}

// A claim handed in through an entry surface (today: a message forwarded
// to the Telegram bot), as the server lets its owner see it. Text is
// present only while the intake is OPEN.
export interface ResearchIntakeView {
  intakeId: string;
  status: "OPEN" | "CONSUMED";
  rawText: string | null;
  detectedProject: { slug: string; name: string; availableInPrivateBeta: boolean | null } | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  researchJobId: string | null;
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
  // 1 = the caveat was written in the v1 claim form; null = legacy free text.
  // Optional: older payloads and fixtures do not carry it (read as legacy).
  doesNotProveRuleVersion?: number | null;
  mechanismState: string | null;
  // 1 = the state is backed by a validated explicit state cue; null = uncued.
  // Optional: older payloads and fixtures do not carry it (read as uncued).
  mechanismStateRuleVersion?: number | null;
  valueSource: string | null;
  sourceClass: string | null;
  officiality: string | null;
  // Typed chain fact kind; null on documentary rows. Optional: older
  // payloads and fixtures do not carry it.
  onchainFactKind?: string | null;
  observedAt: string | null;
  dataAsOf: string | null;
  publishedAt: string | null;
  // 1 = produced under the strict publication-date rule; null = legacy.
  // Optional: older payloads and fixtures do not carry it (read as legacy).
  publishedAtRuleVersion?: number | null;
  retrievedUrl: string;
  fetchedAt: string;
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
  fetchedAt: string;
  source: { title: string | null; publisher: string | null; sourceType: string };
}

// THE RESEARCH BOUNDARY RECORD, as S8 persisted it (`proofs.bounded_by`).
// Per component not SUPPORTED: the closed technical codes the engine wrote
// (never rendered as such — the surface translates the KIND of boundary:
// technical, configuration or substantive) and, beside a recovery-limit
// code, the known evidence paths still open by kind.
export interface ProofBoundaryEntry {
  step: number;
  component: string;
  codes: string[];
  remainingPaths?: { kind: string; count: number }[];
}
export interface ProofBoundaryView {
  version: number;
  technical: ProofBoundaryEntry[];
  substantive: ProofBoundaryEntry[];
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
  // Null on a Proof written before the boundary record existed: the
  // surface then reads the persisted reason codes and coverage instead,
  // and never invents a boundary kind it cannot ground.
  boundedBy: ProofBoundaryView | null;
}

// ATLAS SOURCE SNAPSHOT — the document acquisition actually stored, plus
// the provenance that makes it checkable. `content` is TEXT in every case:
// a markdown resource kept verbatim, an HTML page reduced to its text by
// the transport before it was ever persisted. There is no stored markup,
// so there is nothing here that could execute.
export interface SourceSnapshotView {
  evidenceId: string;
  retrievedUrl: string;
  // The engine's own classification of the source, projected from
  // `evidence.source_class`. Null on legacy Evidence, which shows no badge
  // rather than an invented one.
  sourceClass: string | null;
  // The passage this Evidence row cited, from `evidence.fragment`. A
  // flattened capture leads with it instead of with its own wall of text.
  fragment: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  representation: "MARKDOWN_SOURCE" | "EXTRACTED_TEXT" | "TEXT";
  byteLength: number;
  contentHash: string;
  textSha256: string;
  capturedAt: string;
  renderMode: string;
  content: string;
  truncated: boolean;
  fullLength: number;
}

// THE AUDIT PROJECTION, AND NOTE WHAT IS ABSENT.
//
// An order, short human labels for canonical component references, and two
// or three sentences of connective copy. NO status, NO count, NO evidence
// id, NO reason code — every fact the audit shows is assembled from the
// canonical rows in the detail payload, so this artifact cannot contradict
// research and a FAILED one costs the audit its arrangement, not its
// substance.
export interface AuditProjectionView {
  status: "VALID" | "FAILED_VALIDATION" | "FAILED_MODEL";
  content: {
    summary: string;
    sectionOrder: string[];
    scopeLabels: { patternStep: number; component: string; label: string }[];
  };
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
  // QUESTION-DRIVEN FINDINGS — presentation only, and note what is absent.
  //
  // A label and canonical component keys. NO status, NO reason, NO
  // evidence id: those are derived on the client from the `components`
  // rows in this same response, exactly as they were before this existed.
  // The projection decides which findings matter to the question that was
  // asked and what to call them; canonical research decides what is true.
  //
  // Null means no usable projection — never generated, generated and
  // failed, or its references no longer resolve. The UI falls back to the
  // canonical result rather than inventing a question-shaped one.
  questionFindings:
    | {
        label: string;
        patternStep: number;
        component: string;
        supportingComponents: string[];
      }[]
    | null;
  // STRUCTURED QUANTITIES, AS STORED. Each one is a field copy of an
  // on-chain retrieval artifact this research already persisted — the
  // amount exact as an integer string (a token supply routinely exceeds
  // Number.MAX_SAFE_INTEGER), with the unit domain that gives it meaning
  // and the Evidence row that carries it. The server projects a CLOSED set
  // of fact kinds and drops any row whose canonical fields are incomplete,
  // so an entry here is always showable and an absent measurement is
  // simply absent — never a zero, never a guessed unit.
  quantities: {
    evidenceId: string;
    // The stored retrieval artifact this value was read from — one row per
    // chain read, with its own slot and hash. Two Evidence rows citing the
    // same id are one observation referenced twice; two ids are two
    // observations, however alike their numbers.
    observationId: string;
    factKind: string;
    step: number;
    component: string;
    mint: string;
    decimals: number;
    amountRaw: string;
  }[];
  components: {
    patternStep: number;
    component: string;
    status: string;
    reasonCodes: unknown[];
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
    excludedEvidence: { evidenceId: string; reason: string }[];
    // How complete the checking for THIS component was, reduced from
    // research_attempts on the server. Separates "the public record is
    // silent" from "this run could not look" — a distinction the
    // reconciler cannot make, because it only ever sees Evidence rows.
    coverage: ComponentCoverage;
  }[];
  // Whether an ATLAS Source Snapshot exists for this row — the capture
  // the acquisition path already stored. A boolean, never the capture:
  // content is fetched on demand from /snapshots/[evidenceId].
  snapshotEvidenceIds: string[];
  evidence: (ResearchEvidenceView & {
    hasSnapshot: boolean;
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
  // `intakeId` names the research intake (a forwarded claim) this question
  // came from, so the server can mark it consumed once a job exists. It
  // grants nothing: admission is decided exactly as without it.
  startResearch: (interpretationId: string, idempotencyKey: string, intakeId?: string) =>
    requestChecked<{ job: { id: string; state: string } }>("/api/research-jobs", {
      method: "POST",
      body: JSON.stringify(intakeId ? { interpretationId, idempotencyKey, intakeId } : { interpretationId, idempotencyKey }),
    }),
  getIntake: (id: string) => requestChecked<{ intake: ResearchIntakeView }>(`/api/intakes/${id}`, { method: "GET" }),
  // D-170: the invite comes from the SIGNED Telegram start parameter; the
  // server grants only the session's own user, never one named here.
  redeemBetaInvite: (invite: string) =>
    requestChecked<{ result: "GRANTED" | "ALREADY_GRANTED" }>("/api/private-beta/invite", {
      method: "POST",
      body: JSON.stringify({ invite }),
    }),
  sendBetaFeedback: (input: BetaFeedbackInput) =>
    requestChecked<{ recorded: "SUBMITTED" | "DISMISSED" }>("/api/beta-feedback", {
      method: "POST",
      body: JSON.stringify(input),
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
  // ON DEMAND, AND ONLY ON DEMAND. A capture runs to tens of kilobytes;
  // a reader who opens no source downloads none. This reads a document
  // acquisition already stored — it never triggers a fetch of its own.
  getSourceSnapshot: (jobId: string, evidenceId: string) =>
    requestChecked<{ snapshot: SourceSnapshotView }>(
      `/api/research-jobs/${jobId}/snapshots/${evidenceId}`,
      { method: "GET" },
    ),
  // FULL RESEARCH AUDIT — read, and prepare.
  //
  // `getAudit` never generates: opening a Result costs nothing because the
  // Result only ever reads. `prepareAudit` is reachable only from an
  // explicit click, generates at most once per job, and persists its
  // outcome — including failure, so a failed audit is never retried on a
  // later page load.
  getAudit: (id: string) =>
    requestChecked<{ audit: AuditProjectionView | null }>(
      `/api/research-jobs/${id}/audit`,
      { method: "GET" },
    ),
  prepareAudit: (id: string) =>
    requestChecked<{ audit: AuditProjectionView | null }>(
      `/api/research-jobs/${id}/audit`,
      { method: "POST" },
    ),
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
