import type { GateView, InterpretationView } from "./api";

// THE CLIENT'S ONE RULE FOR "MAY THIS QUESTION START A PROOF".
//
// The server already answers this question. `evaluateGates` (gates.ts)
// documents `research === "AVAILABLE"` as meaning exactly one thing —
// "startResearch would let this through right now" — and it is the ONLY
// field that folds in every input the decision actually depends on:
// route, scope, entitlement, the DEMO quota, the research switch, the
// one-active-job rule, AND the owner-alpha eligibility that legitimately
// overrides several of them.
//
// The other fields are AXES, not verdicts. `entitlement` says what this
// user's subscription alone would allow; it is deliberately computed
// without the owner-alpha override, because owner-alpha admission
// bypasses entitlement and DEMO quota by design (start-owner-alpha-
// research.ts uses a fixed ARI_CORE/INTERNAL_ALPHA_V1 snapshot and checks
// neither). Reading `entitlement` as if it were the verdict therefore
// re-derives a policy the client has no business owning — and gets it
// wrong for precisely the case owner-alpha exists to serve.
//
// That is not hypothetical: an ADMIN asking about a project outside
// `demo_project_slugs` gets research=AVAILABLE (eligible) together with
// entitlement=CORE_REQUIRED (a DEMO subscription cannot reach that
// project), and a client that required both saw a disabled button and
// told the owner to buy the product they own.
//
// So: consume the verdict, never recompute it. This module contains no
// role check, no project list, no configuration, and nothing about
// phases — it cannot grant eligibility the server did not grant, and it
// cannot withhold eligibility the server did grant.

export type ProofBlockReason =
  | "OUT_OF_SCOPE"
  | "CORE_REQUIRED"
  | "DEMO_QUOTA_EXHAUSTED"
  | "ACTIVE_JOB_EXISTS"
  | "DISABLED";

export interface ProofGateSubject {
  interpretation: Pick<InterpretationView, "status" | "route"> | null;
  gates: Pick<GateView, "research"> | null;
}

// A Proof may be started only when the interpretation is a finished
// research request AND the server says research is available. Scope,
// entitlement and quota are not re-checked here: `AVAILABLE` already
// implies every one of them.
export function canStartProof(subject: ProofGateSubject): boolean {
  const { interpretation, gates } = subject;
  if (!interpretation || !gates) return false;
  if (interpretation.status !== "READY") return false;
  if (interpretation.route !== "DEEP_RESEARCH") return false;
  return gates.research === "AVAILABLE";
}

// Why the button is not offered, when the reason is worth showing. A
// non-research answer (an explanation, or nothing to research) is not a
// blocked Proof but a different kind of answer, so it gets no note at
// all — the button should not be on that screen in the first place.
//
// Derived from the SAME field the decision uses, so the message can never
// contradict the button.
export function proofBlockReason(subject: ProofGateSubject): ProofBlockReason | null {
  const { interpretation, gates } = subject;
  if (!interpretation || !gates) return null;
  if (interpretation.status !== "READY") return null;
  if (interpretation.route !== "DEEP_RESEARCH") return null;
  switch (gates.research) {
    case "OUT_OF_SCOPE":
      return "OUT_OF_SCOPE";
    case "CORE_REQUIRED":
      return "CORE_REQUIRED";
    case "DEMO_QUOTA_EXHAUSTED":
      return "DEMO_QUOTA_EXHAUSTED";
    case "ACTIVE_JOB_EXISTS":
      return "ACTIVE_JOB_EXISTS";
    case "DISABLED":
      return "DISABLED";
    case "AVAILABLE":
    case "NOT_DEEP_RESEARCH":
      return null;
  }
}
