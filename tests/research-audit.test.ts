import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  auditOutcome,
  availableAuditSections,
  buildAuditContent,
  limitationKind,
  orderAuditSections,
  AUDIT_SECTION_IDS,
  type AuditComponentRow,
  type AuditEvidenceRow,
  type AuditProjectionRow,
} from "../src/client/audit-model";
import {
  buildAuditInput,
  validateAuditProjection,
  AUDIT_SECTIONS,
  AUDIT_VERSION,
  type AuditModelInput,
} from "../src/server/engine/audit-projection";

// FULL RESEARCH AUDIT.
//
// The Result answers "what is the answer?". The Audit answers "can I
// professionally inspect how that answer was reached?". These tests pin
// the two properties that separate an audit from a prettier result:
//
//   THE MODEL ORGANISES. It supplies an order, short human labels and two
//   sentences of connective copy — and its output schema has no field for
//   a status, a count, an evidence id or a reason code, so it cannot
//   assert anything about a project even by ignoring its prompt.
//
//   CODE GUARANTEES COMPLETENESS. This is the inverse of Question
//   Projection, where omission is the point. A section canonical research
//   gave content to renders whether or not the model mentioned it, so a
//   model can never quietly shorten the record.

const STORE = "src/server/engine/audit-projection-store.ts";
const ROUTE = "app/api/research-jobs/[id]/audit/route.ts";
const PAGE = "app/(app)/research/[id]/page.tsx";
const SURFACE = "src/client/components/research-audit.tsx";
const RUN_JOB = "src/server/engine/run-job.ts";
const PURE = "src/server/engine/audit-projection.ts";
const PROVIDER = "src/server/engine/providers/audit-projection-anthropic.ts";
const AUDIT_PAGE = "app/(app)/research/[id]/audit/page.tsx";

function codeOf(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/* ---------------------------------------------------------------- *
 * CANONICAL FIXTURE — the shape a real job produces
 * ---------------------------------------------------------------- */

const components: AuditComponentRow[] = [
  {
    patternStep: 1,
    component: "SOURCE_OF_VALUE",
    status: "SUPPORTED",
    reasonCodes: [],
    supportingEvidenceIds: ["e1"],
    contradictingEvidenceIds: [],
    excludedEvidence: [{ evidenceId: "e3", reason: "RELATIONSHIP_NOT_SUPPORTING" }],
    coverage: "COMPLETED",
  },
  {
    patternStep: 3,
    component: "GOVERNANCE_BASIS",
    status: "INSUFFICIENT_EVIDENCE",
    reasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    excludedEvidence: [{ evidenceId: "e4", reason: "CLASS_NOT_ADMISSIBLE" }],
    coverage: "COMPLETED",
  },
  {
    patternStep: 5,
    component: "CURRENT_STATE",
    status: "INSUFFICIENT_EVIDENCE",
    reasonCodes: ["NO_EVIDENCE_FOUND"],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    excludedEvidence: [],
    // The run could not reach a source it needed — a fact about the run.
    coverage: "BLOCKED",
  },
  {
    patternStep: 7,
    component: "NET_EFFECT",
    status: "PARTIALLY_SUPPORTED",
    reasonCodes: ["INSUFFICIENT_AUTHORITY"],
    supportingEvidenceIds: ["e2"],
    contradictingEvidenceIds: ["e5"],
    excludedEvidence: [],
    coverage: "PARTIAL",
  },
];

const evidence: AuditEvidenceRow[] = [
  {
    id: "e1",
    retrievedUrl: "https://docs.example.test/fees.md",
    sourceClass: "OFFICIAL_DOCS",
    fragment: "Twelve percent of trading fees are used to buy back the token.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:03:21.000Z",
    hasSnapshot: true,
  },
  {
    id: "e2",
    retrievedUrl: "https://docs.example.test/fees.md",
    sourceClass: "OFFICIAL_DOCS",
    fragment: "Bought-back tokens are held at a public address.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:03:21.000Z",
    hasSnapshot: true,
  },
  {
    id: "e3",
    retrievedUrl: "https://data.example.test/protocol",
    sourceClass: "DATA_PROVIDER",
    fragment: "Protocol revenue over the last month.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:03:25.000Z",
    hasSnapshot: false,
  },
  {
    id: "e4",
    retrievedUrl: "https://blog.example.test/post",
    sourceClass: "SOCIAL",
    fragment: "A commentary post about the mechanism.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:04:30.000Z",
    hasSnapshot: false,
  },
  {
    id: "e5",
    retrievedUrl: "https://data.example.test/protocol",
    sourceClass: "DATA_PROVIDER",
    fragment: "A figure that points the other way.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:03:25.000Z",
    hasSnapshot: false,
  },
  {
    // Read during the run and cited by nothing.
    id: "e6",
    retrievedUrl: "https://news.example.test/article",
    sourceClass: "RESEARCH_MEDIA",
    fragment: "An article the run read and did not rely on.",
    component: "SOURCE_OF_VALUE",
    summary: "A canonical summary of the passage.",
    doesNotProve: "That the mechanism executed.",
    officiality: "CONFIRMED",
    sourceTitle: null,
    fetchedAt: "2026-09-01T18:05:00.000Z",
    hasSnapshot: false,
  },
];

const input: AuditModelInput = buildAuditInput({
  question: "Where does the revenue go?",
  intent: "PROTOCOL_REVENUE_TO_TOKEN",
  components: components.map((c) => ({
    step: c.patternStep,
    component: c.component,
    status: c.status,
    reasonCodes: c.reasonCodes as string[],
    coverage: c.coverage,
    supportingCount: c.supportingEvidenceIds.length,
    contradictingCount: c.contradictingEvidenceIds.length,
    excludedCount: c.excludedEvidence.length,
  })),
  sources: [],
  availableSections: [...AUDIT_SECTIONS],
});

const validOutput = {
  summary:
    "The run covered the documented side of the question and stopped short of the live side. Start with coverage, then read the register for material that was checked and set aside.",
  sectionOrder: [...AUDIT_SECTIONS],
  scopeLabels: [
    { ref: { kind: "COMPONENT" as const, step: 1, component: "SOURCE_OF_VALUE" }, label: "Fee allocation" },
    { ref: { kind: "COMPONENT" as const, step: 5, component: "CURRENT_STATE" }, label: "Current execution" },
  ],
};

/* ---------------------------------------------------------------- *
 * LIFECYCLE — WHEN AN AUDIT MAY COST A MODEL CALL
 * ---------------------------------------------------------------- */

describe("audit lifecycle — prepared only when a human asks", () => {
  it("TEST 1: ordinary Proof completion never generates an audit", () => {
    // run-job.ts generates the question projection after research. It must
    // not have learned to generate an audit as well: most Proofs are never
    // audited, and paying for every one would be paying for a document
    // nobody opened.
    const runJob = codeOf(RUN_JOB);
    expect(runJob).not.toContain("generateAuditProjection");
    expect(runJob).not.toContain("audit-projection");
  });

  it("TEST 2: loading the Result makes no audit request at all", () => {
    const page = codeOf(PAGE);
    // Not a POST, not a GET, not any audit call: rendering the Result
    // leaves the audit untouched. The entry is a LINK to its own route.
    expect(page).not.toContain("prepareAudit");
    expect(page).not.toContain("getAudit");
    expect(page).toContain('href={`/research/${jobId}/audit`}');
    // And on that route exactly one call site exists.
    const auditPage = codeOf(AUDIT_PAGE);
    expect(auditPage.split("prepareAudit(").length - 1).toBe(1);
  });

  it("TEST 3: the first request may generate exactly one projection", () => {
    const store = codeOf(STORE);
    // One provider call, guarded by an existence check that returns first.
    expect(store).toContain("provider.project(input)");
    expect(store.split("provider.project(").length - 1).toBe(1);
    const gate = store.slice(0, store.indexOf("provider.project("));
    expect(gate).toContain('return { kind: "SKIPPED", reason: "ALREADY_EXISTS" }');
  });

  it("TEST 4: a persisted audit is reused, never regenerated", () => {
    const store = codeOf(STORE);
    // The read path exists separately and cannot reach the provider.
    const readFn = store.slice(
      store.indexOf("export async function loadAuditProjection"),
      store.indexOf("export async function generateAuditProjection"),
    );
    expect(readFn).not.toContain("provider");
    expect(readFn).not.toContain("project(");
    // GET serves the read path only.
    const route = codeOf(ROUTE);
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
    expect(get).toContain("loadAuditProjection");
    expect(get).not.toContain("generateAuditProjection");
    // Regeneration needs a human to bump the version.
    expect(AUDIT_VERSION).toBe(1);
    expect(codeOf("src/server/db/schema/projection.ts")).toContain(
      "uq_research_audit_projections_job_version",
    );
  });

  it("TEST 5 + 6: an audit failure cannot change research or the Proof", () => {
    const store = codeOf(STORE);
    // A failure is persisted as a terminal row and RETURNED, never thrown
    // — and nothing in this module writes to a canonical artifact.
    expect(store).toContain('return { kind: "FAILED_MODEL" }');
    expect(store).toContain('return { kind: "FAILED_VALIDATION" }');
    for (const canonical of [
      "researchJobs)\n      .set",
      "update(proofs",
      "update(researchComponentResults",
      "update(researchClaimSupport",
      "insert(proofs",
      "insert(researchComponentResults",
    ]) {
      expect(store, canonical).not.toContain(canonical);
    }
    // The only table it writes is its own.
    const inserts = store.match(/\.insert\((\w+)\)/g) ?? [];
    expect(inserts).toEqual([".insert(researchAuditProjections)"]);
  });

  it("a failed audit is persisted so re-opening does not retry the model", () => {
    const store = codeOf(STORE);
    // Both failure paths persist BEFORE returning, occupying the unique
    // slot exactly as a success would.
    const modelFail = store.slice(store.indexOf("catch (e)"), store.indexOf('return { kind: "FAILED_MODEL" }'));
    expect(modelFail).toContain('persist("FAILED_MODEL"');
    const validationFail = store.slice(
      store.indexOf("if (!validated.ok)"),
      store.indexOf('return { kind: "FAILED_VALIDATION" }'),
    );
    expect(validationFail).toContain('"FAILED_VALIDATION"');
    expect(validationFail).toContain("persist(");
  });
});

/* ---------------------------------------------------------------- *
 * THE MODEL BOUNDARY
 * ---------------------------------------------------------------- */

describe("audit projection — the model organises and nothing more", () => {
  it("TEST 7: an invented canonical reference is rejected", () => {
    const bad = {
      ...validOutput,
      scopeLabels: [
        { ref: { kind: "COMPONENT", step: 9, component: "INVENTED_COMPONENT" }, label: "Something" },
      ],
    };
    const result = validateAuditProjection(bad, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("UNKNOWN_REFERENCE");
  });

  it("TEST 8: the model has no field in which to supply a status", () => {
    // Structural, not prompt-enforced: extra keys are stripped by the
    // schema, so a status a model tried to emit simply does not survive.
    const withStatus = {
      ...validOutput,
      scopeLabels: [
        {
          ref: { kind: "COMPONENT" as const, step: 1, component: "SOURCE_OF_VALUE" },
          label: "Fee allocation",
          status: "SUPPORTED",
          evidenceId: "e1",
        },
      ],
    };
    const result = validateAuditProjection(withStatus, input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.scopeLabels)).not.toContain("SUPPORTED");
      expect(JSON.stringify(result.scopeLabels)).not.toContain("e1");
    }
    // And the pure module declares no such field anywhere.
    const pure = codeOf(PURE);
    const schema = pure.slice(pure.indexOf("auditOutputSchema"), pure.indexOf("AuditRejection"));
    for (const forbidden of ["status", "verdict", "evidenceId", "reasonCode", "count"]) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
  });

  it("a label that asserts a status is rejected", () => {
    for (const label of ["Fee allocation established", "Verified destination", "Unproven supply effect"]) {
      const result = validateAuditProjection(
        {
          ...validOutput,
          scopeLabels: [
            { ref: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, label },
          ],
        },
        input,
      );
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.rejection).toBe("LABEL_ASSERTS_STATUS");
    }
  });

  it("internal Pattern vocabulary cannot reach a label", () => {
    const result = validateAuditProjection(
      {
        ...validOutput,
        scopeLabels: [
          { ref: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, label: "SOURCE_OF_VALUE" },
        ],
      },
      input,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("LABEL_IS_INTERNAL_VOCABULARY");
  });

  it("counts can never originate from the model", () => {
    // Every number on the audit is arithmetic over canonical rows, so the
    // model's own prose may not contain a digit at all.
    const result = validateAuditProjection(
      { ...validOutput, summary: "The run covered 3 of 4 research points." },
      input,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toBe("PROSE_CONTAINS_NUMBER");
  });

  it("a well-formed projection is admitted intact", () => {
    const result = validateAuditProjection(validOutput, input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeLabels).toHaveLength(2);
      expect(result.sectionOrder).toEqual([...AUDIT_SECTIONS]);
    }
  });

  it("the model never receives a document, a fragment or a url", () => {
    const provider = codeOf(PROVIDER);
    const content = provider.slice(provider.indexOf("buildAuditUserContent"));
    for (const forbidden of ["fragment", "normalizedText", "retrievedUrl", "excerpt", "summary:"]) {
      expect(content, forbidden).not.toContain(forbidden);
    }
    // Sources appear as domain + class + used flag, nothing more.
    expect(content).toContain("s.domain");
    expect(content).toContain("s.sourceClass");
    // TEST 17: no new vendor, and no tools that could widen research.
    expect(provider).toContain("@anthropic-ai/sdk");
    expect(provider).not.toContain("tools:");
    expect(provider).not.toContain("web_search");
  });
});

/* ---------------------------------------------------------------- *
 * COMPLETENESS — THE MODEL CANNOT SHORTEN THE RECORD
 * ---------------------------------------------------------------- */

describe("audit completeness — guaranteed by code, not by the model", () => {
  const content = buildAuditContent(components, evidence, null);
  const available = availableAuditSections(content);

  it("TEST 9: a contradiction cannot be omitted by the model", () => {
    const conflicts = content.openItems.filter((i) => i.kind === "CONFLICT");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].component).toBe("NET_EFFECT");
    // Even if the model orders no sections at all.
    expect(orderAuditSections([], available)).toContain("OPEN_QUESTIONS");
    expect(orderAuditSections(null, available)).toContain("OPEN_QUESTIONS");
  });

  it("TEST 10: a technical limitation cannot be omitted, and is not an evidence gap", () => {
    const technical = content.openItems.filter((i) => i.kind === "TECHNICAL_LIMITATION");
    expect(technical).toHaveLength(1);
    expect(technical[0].component).toBe("CURRENT_STATE");
    // The distinction the normal Result cannot draw, stated explicitly.
    expect(technical[0].detail).toMatch(/limitation of the run, not evidence that/i);
    expect(limitationKind(components[2])).toBe("TECHNICAL");
    expect(limitationKind(components[1])).toBe("EVIDENCE");
  });

  it("TEST 11: excluded and unused source accounting cannot be silently omitted", () => {
    expect(available).toContain("SOURCE_REGISTER");
    expect(orderAuditSections(["SUMMARY"], available)).toContain("SOURCE_REGISTER");
    // The run read a document nothing cited, and it is accounted for.
    const notUsedKeys = content.register.checkedNotUsed.map((s) => s.sourceKey);
    expect(notUsedKeys).toContain("https://news.example.test/article");
    expect(notUsedKeys).toContain("https://blog.example.test/post");
    // With the engine's own recorded reason where there was one.
    const blog = content.register.checkedNotUsed.find(
      (s) => s.sourceKey === "https://blog.example.test/post",
    );
    expect(blog?.notUsedReasons.length).toBeGreaterThan(0);
  });

  it("a section the model omits is re-added; one it invents is dropped", () => {
    // Omission cannot shorten the audit.
    const ordered = orderAuditSections(["TRACE"], available);
    expect(ordered[0]).toBe("TRACE");
    for (const id of available) expect(ordered).toContain(id);
    // And a section with no canonical content is never conjured. This job
    // produced no on-chain artifacts.
    expect(available).not.toContain("ONCHAIN");
    expect(orderAuditSections(["ONCHAIN", "SUMMARY"], available)).not.toContain("ONCHAIN");
  });

  it("empty sections are not created mechanically", () => {
    const bare = buildAuditContent([], [], null);
    const bareSections = availableAuditSections(bare);
    expect(bareSections).not.toContain("EVIDENCE_MAP");
    expect(bareSections).not.toContain("SOURCE_REGISTER");
    expect(bareSections).not.toContain("OPEN_QUESTIONS");
  });

  it("a failed projection costs the audit its labels, not its substance", () => {
    // Exactly the same canonical content, with canonical labels.
    const withProjection = buildAuditContent(components, evidence, {
      summary: "x",
      sectionOrder: [],
      scopeLabels: [{ patternStep: 1, component: "SOURCE_OF_VALUE", label: "Fee allocation" }],
    } as AuditProjectionRow);
    expect(withProjection.scope).toHaveLength(content.scope.length);
    expect(withProjection.counts).toEqual(content.counts);
    expect(content.scope[0].labelSource).toBe("CANONICAL");
    expect(withProjection.scope[0].labelSource).toBe("PROJECTION");
    expect(withProjection.scope[0].label).toBe("Fee allocation");
  });
});

/* ---------------------------------------------------------------- *
 * EVIDENCE MAP AND SOURCE REGISTER
 * ---------------------------------------------------------------- */

describe("audit evidence map and source register", () => {
  const content = buildAuditContent(components, evidence, null);

  it("TEST 12: the evidence map references canonical provenance only", () => {
    const ids = content.evidenceMap.flatMap((g) =>
      [...g.admitted, ...g.excluded].flatMap((l) => l.evidenceIds),
    );
    for (const id of ids) expect(evidence.some((e) => e.id === id)).toBe(true);
    // A referenced row that is not in the payload is dropped, never invented.
    const withDangling = buildAuditContent(
      [{ ...components[0], supportingEvidenceIds: ["does-not-exist"] }],
      evidence,
      null,
    );
    const dangling = withDangling.evidenceMap.flatMap((g) =>
      [...g.admitted, ...g.excluded].flatMap((l) => l.evidenceIds),
    );
    expect(dangling).not.toContain("does-not-exist");
  });

  it("each relationship states what the source can establish and what it cannot", () => {
    const group = content.evidenceMap.find((g) => g.component === "SOURCE_OF_VALUE");
    const link = group?.admitted.find((l) => l.role === "SUPPORTING");
    expect(link?.canEstablish).toBeTruthy();
    expect(link?.cannotEstablish ?? link?.doesNotProve).toBeTruthy();
  });

  it("the evidence map groups by DOCUMENT, so one source is one relationship", () => {
    // NET_EFFECT cites e2 (docs) and e5 (data provider). The docs domain
    // also carried SOURCE_OF_VALUE via e1 — one document, one row per
    // point, never a repeated source identity card.
    const group = content.evidenceMap.find((g) => g.component === "NET_EFFECT");
    expect(group?.admitted.map((l) => l.domain).sort()).toEqual([
      "data.example.test",
      "docs.example.test",
    ]);
    for (const l of group?.admitted ?? []) expect(l.evidenceCount).toBe(1);
    // And refused material collapses to one line per source with a count.
    const governance = content.evidenceMap.find((g) => g.component === "GOVERNANCE_BASIS");
    expect(governance?.admitted).toHaveLength(0);
    expect(governance?.excluded).toHaveLength(1);
    expect(governance?.excluded[0].exclusionReasons.length).toBeGreaterThan(0);
  });

  it("TEST 13: the register deduplicates canonical documents", () => {
    // e1 and e2 came from ONE document. Three Evidence rows from one
    // document are not three corroborating sources.
    const docs = content.register.used.filter(
      (s) => s.sourceKey === "https://docs.example.test/fees.md",
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].evidenceIds.sort()).toEqual(["e1", "e2"]);
    const allKeys = [
      ...content.register.used.map((s) => s.sourceKey),
      ...content.register.checkedNotUsed.map((s) => s.sourceKey),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it("TEST 14: used and not-used stay distinct, and a document is never both", () => {
    const used = new Set(content.register.used.map((s) => s.sourceKey));
    const notUsed = new Set(content.register.checkedNotUsed.map((s) => s.sourceKey));
    for (const key of used) expect(notUsed.has(key)).toBe(false);
    // The data provider IS used — one of its rows is contradicting
    // evidence for NET_EFFECT, and contradicting is still used.
    expect(used.has("https://data.example.test/protocol")).toBe(true);
    expect(used.has("https://docs.example.test/fees.md")).toBe(true);
  });

  it("a used document records which research points it contributed to", () => {
    const docs = content.register.used.find(
      (s) => s.sourceKey === "https://docs.example.test/fees.md",
    );
    expect(docs?.contributedTo.map((c) => c.component).sort()).toEqual([
      "NET_EFFECT",
      "SOURCE_OF_VALUE",
    ]);
  });

  it("TEST 15: snapshot links stay job- and source-scoped, reusing one implementation", () => {
    const surface = codeOf(SURFACE);
    // The SAME route the result card uses, addressed by (job, evidence).
    expect(surface).toContain("`/research/${jobId}/source/${evidenceId}`");
    // Offered only where a capture exists — absent, not dead.
    expect(surface).toContain("link.hasSnapshot && evidenceId && jobId");
    // No second snapshot implementation.
    expect(surface).not.toContain("SnapshotDocumentView");
    expect(surface).not.toContain("parseSnapshotDocument");
    expect(surface).not.toContain("getSourceSnapshot");
  });

  it("on-chain is reported as unavailable rather than fabricated", () => {
    expect(content.onchain.available).toBe(false);
    expect(content.onchain.entries).toHaveLength(0);
    // Named honestly, so a reader knows nothing was produced rather than
    // wondering whether the audit forgot.
    expect(content.onchain.missingFields).toContain("onchain_artifact_id");
    expect(availableAuditSections(content)).not.toContain("ONCHAIN");
  });
});

/* ---------------------------------------------------------------- *
 * THE AUDIT IS NOT THE RESULT AGAIN
 * ---------------------------------------------------------------- */

describe("audit is a different surface, not the result repeated", () => {
  it("TEST 20 + 21: the audit adds what the Result structurally cannot show", () => {
    const surface = codeOf(SURFACE);
    // NONE of the Result's own composition appears here.
    for (const resultPart of [
      "ResultLadder",
      "researchAnswer",
      "deriveQuestionFindings",
      "OutcomeBadge",
      "findingExplanation",
      "EvidenceSection",
    ]) {
      expect(surface, resultPart).not.toContain(resultPart);
    }
    // And the Result no longer renders a second copy of itself as "audit".
    const page = codeOf(PAGE);
    expect(page).not.toContain("audit-full-ladder");
    expect(page.split("<ResultLadder").length - 1).toBe(1);

    // The materially new information, all canonical and none of it on the
    // Result: coverage state, the technical/evidence distinction, source
    // suitability, exclusion reasons, and the not-used ledger.
    const content = buildAuditContent(components, evidence, null);
    expect(content.scope.some((s) => s.coverage === "BLOCKED")).toBe(true);
    expect(content.scope.some((s) => s.limitation === "TECHNICAL")).toBe(true);
    expect(content.register.checkedNotUsed.length).toBeGreaterThan(0);
    expect(content.counts.exclusions).toBeGreaterThan(0);
  });

  it("internal enums live one level below even the trace", () => {
    // Scanned over the RENDER: comments explain the rule and a ban a
    // denial trips measures documentation rather than the screen.
    const surface = codeOf(SURFACE);
    const trace = surface.slice(surface.indexOf("function Trace("));
    // The trace itself reads in ordinary words — spelled-out counts, the
    // same outcome vocabulary, no compact codes.
    expect(trace).toContain("Supporting:");
    expect(trace).toContain("Conflicting:");
    expect(trace).toContain("Excluded:");
    expect(trace).toContain("outcomeLabel");
    expect(trace).not.toMatch(/}s · {/);
    // Raw identifiers exist, but only behind an explicit developer
    // disclosure inside the trace.
    expect(trace).toContain("Developer details");
    const devBlock = trace.slice(trace.indexOf("Developer details"));
    expect(devBlock).toContain("component:");
    expect(devBlock).toContain("reason_codes:");
    // Nothing above the trace exposes engine vocabulary at all.
    const aboveTrace = surface.slice(
      surface.indexOf("function Coverage("),
      surface.indexOf("function Trace("),
    );
    expect(aboveTrace).toContain("item.label");
    expect(aboveTrace).not.toMatch(/SOURCE_OF_VALUE|NET_EFFECT|reason_code|.status/);
  });

  it("one outcome word is derived from both canonical axes, losing neither", () => {
    // The translation the audit shows, and the distinction it must keep.
    expect(auditOutcome("SUPPORTED", "COMPLETED")).toBe("CONFIRMED");
    expect(auditOutcome("PARTIALLY_SUPPORTED", "COMPLETED")).toBe("PARTIALLY_CONFIRMED");
    expect(auditOutcome("CONTRADICTED", "COMPLETED")).toBe("CONTRADICTED");
    // The branch that matters: unreachable is NOT the same as checked-and-empty.
    expect(auditOutcome("INSUFFICIENT_EVIDENCE", "BLOCKED")).toBe("RESEARCH_BLOCKED");
    expect(auditOutcome("INSUFFICIENT_EVIDENCE", "COMPLETED")).toBe("COULD_NOT_VERIFY");
    expect(auditOutcome("INSUFFICIENT_EVIDENCE", "NOT_ATTEMPTED")).toBe("COULD_NOT_VERIFY");
    // Canonical status and coverage both survive on the row.
    const content = buildAuditContent(components, evidence, null);
    const blocked = content.scope.find((s) => s.component === "CURRENT_STATE");
    expect(blocked?.outcomeLabel).toBe("Research blocked");
    expect(blocked?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(blocked?.coverage).toBe("BLOCKED");
  });

  it("progressive depth — the audit does not open everything at once", () => {
    const surface = codeOf(SURFACE);
    // The STATE of the research is open; the deep material is a click
    // down. The evidence map and the trace are where a reader goes with a
    // specific question, not where they land.
    // The STATE of the research is open; the deep material is a click
    // down. The evidence map and the trace are where a reader goes with a
    // specific question, not where they land.
    const openList = surface.slice(
      surface.indexOf("OPEN_BY_DEFAULT"),
      surface.indexOf("];", surface.indexOf("OPEN_BY_DEFAULT")),
    );
    for (const open of ["SUMMARY", "COVERAGE", "OPEN_QUESTIONS", "SOURCE_REGISTER"]) {
      expect(openList, open).toContain(open);
    }
    expect(openList).not.toContain("EVIDENCE_MAP");
    expect(openList).not.toContain("TRACE");
    expect(surface).toContain("<details");
    // No raw JSON dump on the default surface.
    expect(surface).not.toContain("JSON.stringify");
  });

  it("TEST 22: nothing is keyed to a specific project", () => {
    for (const path of [PURE, STORE, SURFACE, "src/client/audit-model.ts", PROVIDER, ROUTE]) {
      // Scanned over the RENDER: a comment may cite the live run that
      // exposed a bug — that is provenance for the fix, not a branch on
      // the project. What must never exist is project-keyed CODE.
      const src = codeOf(path);
      expect(src.toLowerCase(), path).not.toContain("raydium");
      expect(src.toLowerCase(), path).not.toContain("pump_fun");
      expect(src, path).not.toMatch(/projectSlug\s*===/);
    }
  });

  it("TEST 16 + 18 + 19: no research, no question-projection change, no S7 change", () => {
    const store = codeOf(STORE);
    // Nothing here can start, resume or extend research.
    for (const forbidden of ["startResearch", "enqueue", "pgBoss", "runJob", "acquire", "fetch("]) {
      expect(store, forbidden).not.toContain(forbidden);
    }
    // The question projection contract is untouched by this round.
    const qp = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(qp).toContain("export const PROJECTION_VERSION = 1");
    expect(qp).not.toContain("AUDIT");
    // S7 claim support is READ, never written.
    expect(store).toContain("researchClaimSupport");
    expect(store).not.toContain("update(researchClaimSupport");
    expect(store).not.toContain("insert(researchClaimSupport");
  });

  it("every section id is known to both layers", () => {
    expect([...AUDIT_SECTION_IDS].sort()).toEqual([...AUDIT_SECTIONS].sort());
  });
});
