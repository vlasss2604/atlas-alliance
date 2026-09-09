// THE PRESENTATION LANGUAGE OF AN ATLAS RESEARCH RESULT.
//
// These are the typed shapes an analytical result is composed from. They
// exist so the result stops being one component full of prose and becomes a
// set of blocks that each present ONE kind of information in the form that
// kind of information deserves — a number as a number, a movement as a
// flow, comparable rows as a table, a capture as evidence.
//
// NOTHING HERE READS THE ENGINE, AND NOTHING HERE DECIDES ANYTHING. Every
// block takes data and renders it. The adapter that will one day choose
// which block a real finding belongs in is deliberately NOT built yet: the
// presentation language is approved first, and a selection rule written
// before that would encode a layout nobody has agreed to.
//
// ONE STATE VOCABULARY FOR THE WHOLE RESULT. Every block that shows how far
// the evidence got uses `ProofState` and nothing else, so a reader meets the
// same four words on the proof map, in the flow, on the timeline and beside
// an entity. Adding a fifth state is a product decision, and the union makes
// it one.
export type ProofState =
  | "ESTABLISHED"
  | "PARTLY_ESTABLISHED"
  | "NOT_ESTABLISHED"
  | "CONTRADICTED";

// COLOUR IS NEVER THE ONLY CARRIER. Each state ships with its own words
// wherever it appears; the colour is a second, faster channel and never the
// first. The four hues are the product's existing status colours — teal for
// what stands, violet for what stands in part, amber for what the evidence
// did not reach, red reserved for a positive contradiction alone.
export const PROOF_STATE: Record<
  ProofState,
  { label: string; color: string; dim: string }
> = {
  ESTABLISHED: { label: "Established", color: "#5eead4", dim: "rgba(45, 212, 191, 0.14)" },
  PARTLY_ESTABLISHED: { label: "Partly established", color: "#c4b5fd", dim: "rgba(167, 139, 250, 0.14)" },
  NOT_ESTABLISHED: { label: "Not established", color: "#fcd34d", dim: "rgba(251, 191, 36, 0.13)" },
  CONTRADICTED: { label: "Evidence indicates otherwise", color: "#fca5a5", dim: "rgba(248, 113, 113, 0.14)" },
};

/* ---------------------------- 1. HEADER ---------------------------- */

export interface AnswerHeader {
  question: string;
  verdict: string;
  confidence: string;
  // Three to five sentences. The ONLY substantial prose at the top of a
  // result — everything below communicates through structure.
  answer: string[];
  asOf: string;
}

/* --------------------------- 2. PROOF MAP -------------------------- */

export interface ProofMapCell {
  label: string;
  state: ProofState;
  // One short clause, optional. A proof map is a shape, not a summary: a
  // cell that needs a sentence belongs in the ladder, not here.
  note?: string;
}

/* -------------------------- 3. KEY METRICS ------------------------- */

export interface Metric {
  // Rendered first and largest. A metric that reads as a sentence is not a
  // metric — the number is the point and the words are its caption.
  value: string;
  unit?: string;
  label: string;
  state: ProofState;
  period?: string;
  source?: string;
}

/* ------------------------ 4. MECHANISM FLOW ------------------------ */

export interface FlowStage {
  label: string;
  state: ProofState;
  detail?: string;
}

/* ----------------------- 5. ANALYTICAL TABLE ----------------------- */

export interface TableColumn {
  key: string;
  label: string;
  // Numeric columns are right-aligned and tabular so digits stack, which is
  // most of what makes a table scannable.
  numeric?: boolean;
  unit?: string;
}

export interface TableRow {
  key: string;
  cells: Record<string, string>;
  state?: ProofState;
}

/* ------------------------- 6. QUANTITATIVE ------------------------- */

export interface ChartPoint {
  label: string;
  value: number | null;
  // A period the research did not establish carries NO value. It is drawn as
  // an empty slot with its own label rather than as a zero — a zero is a
  // measurement, and "we could not establish this" is not one.
  state: ProofState;
}

/* --------------------------- 7. TIMELINE --------------------------- */

export interface TimelineEvent {
  date: string;
  label: string;
  state: ProofState;
  // What KIND of milestone this is. ATLAS's whole discipline is that these
  // are different claims: a document is not an approval, an approval is not
  // an activation, and none of them is an execution.
  kind: "DOCUMENTED" | "APPROVED" | "ACTIVATED" | "EXECUTED";
  note?: string;
}

/* --------------------------- 8. ENTITIES --------------------------- */

export interface EntityRef {
  role: string;
  address: string;
  chain: string;
  state: ProofState;
  evidenceRef?: string;
}

/* ----------------------- 9. EVIDENCE SNAPSHOT ---------------------- */

export interface EvidenceKindMeta {
  kind: "DOCUMENTARY" | "ON_CHAIN" | "GOVERNANCE" | "QUANTITATIVE";
  source: string;
  // The retrieved passage, verbatim. Always shown before any paraphrase.
  fragment: string;
  proves: string;
  // The sentence that keeps a snapshot honest. It is why this block is the
  // one the product already trusts most.
  doesNotProve: string;
  retrievedAt: string;
  href?: string;
}

export const EVIDENCE_KIND_LABEL: Record<EvidenceKindMeta["kind"], string> = {
  DOCUMENTARY: "Documentary",
  ON_CHAIN: "On-chain",
  GOVERNANCE: "Governance",
  QUANTITATIVE: "Quantitative",
};
