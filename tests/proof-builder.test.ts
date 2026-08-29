import { describe, expect, it } from "vitest";

import {
  buildProof,
  PROOF_LAYER_TITLES,
  PROOF_LAYERS_VERSION,
  type ClaimSupportProjection,
  type ComponentResultProjection,
  type ProofBuilderInput,
} from "../src/server/engine/proof-builder";

// S8 — THE PROOF BUILDER, as a projection and nothing more.
//
// Everything here is offline and DB-free by construction: the builder has
// no IO, so these tests are the whole of its behaviour. What they pin is
// mostly what it must NOT do — invent a verdict, invent support, hide a
// gap, cite something that does not exist, or fill layer 5.

function req(over: Partial<ClaimSupportProjection["requirementResults"][number]> = {}) {
  return {
    requirementId: "R1",
    optionality: "REQUIRED" as const,
    status: "SATISFIED" as const,
    reasonCodes: [],
    matchedFlowIds: [],
    blockingGaps: [],
    provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["E1"] },
    ...over,
  };
}

function componentRow(over: Partial<ComponentResultProjection> = {}): ComponentResultProjection {
  return {
    step: 6,
    component: "DESTINATION",
    status: "SUPPORTED",
    reasonCodes: [],
    supportingEvidenceIds: ["E1"],
    excludedEvidence: [],
    ...over,
  };
}

function input(over: Partial<ProofBuilderInput> = {}): ProofBuilderInput {
  return {
    researchJobId: "job-1",
    claimSupport: {
      intent: "does the mechanism send value to the stated destination",
      status: "SUPPORTED",
      reasonCodes: [],
      requirementResults: [req()],
      contextGaps: [],
    },
    componentResults: [componentRow()],
    existingEvidenceIds: ["E1"],
    ...over,
  };
}

function layerOf(out: ReturnType<typeof buildProof>, n: number) {
  if (!out.proof) throw new Error("expected a proof");
  return out.proof.layers.layers.find((l) => l.layer === n)!;
}

describe("verdict is projected from S7 and never recomputed", () => {
  it("every ClaimSupportStatus maps to its namesake verdict", () => {
    for (const status of ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      const out = buildProof(input({ claimSupport: { ...input().claimSupport!, status } }));
      expect(out.proof?.verdict, status).toBe(status);
    }
  });

  it("NOT_APPLICABLE is never emitted — S7 cannot produce it, so S8 must not invent it", () => {
    for (const status of ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      const out = buildProof(input({ claimSupport: { ...input().claimSupport!, status } }));
      expect(out.proof?.verdict).not.toBe("NOT_APPLICABLE");
    }
  });

  it("a strong evidence set never upgrades a weak S7 status", () => {
    // Ten satisfied-looking citations under an INSUFFICIENT_EVIDENCE claim
    // must still yield INSUFFICIENT_EVIDENCE. No majority vote exists.
    const ids = Array.from({ length: 10 }, (_, i) => `E${i}`);
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "INSUFFICIENT_EVIDENCE",
          requirementResults: [req({ provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ids } })],
        },
        componentResults: [componentRow({ supportingEvidenceIds: ids })],
        existingEvidenceIds: ids,
      }),
    );
    expect(out.proof?.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.proof?.citedEvidenceIds).toHaveLength(10);
  });
});

describe("fail closed: no S7 means no Proof", () => {
  it("returns a closed refusal, never an empty or placeholder Proof", () => {
    const out = buildProof(input({ claimSupport: null }));
    expect(out.proof).toBeNull();
    expect(out.refusal).toBe("NO_CLAIM_SUPPORT");
  });
});

describe("citations resolve, or they do not appear", () => {
  it("an id the claim cites but Evidence does not contain is dropped", () => {
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          requirementResults: [
            req({ provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["E1", "GHOST"] } }),
          ],
        },
        componentResults: [componentRow({ supportingEvidenceIds: ["E1", "GHOST"] })],
        existingEvidenceIds: ["E1"], // GHOST does not exist
      }),
    );
    expect(out.proof?.citedEvidenceIds).toEqual(["E1"]);
  });

  it("evidence belonging to a component the claim never referenced is not cited", () => {
    const out = buildProof(
      input({
        componentResults: [
          componentRow(),
          componentRow({ step: 1, component: "SOURCE_OF_VALUE", supportingEvidenceIds: ["OTHER"] }),
        ],
        existingEvidenceIds: ["E1", "OTHER"],
      }),
    );
    expect(out.proof?.citedEvidenceIds).toEqual(["E1"]);
    expect(out.proof?.citations.every((c) => c.component === "DESTINATION")).toBe(true);
  });

  it("evidence the component did not treat as supporting is not cited", () => {
    // An excluded row cannot be cited as support even if the requirement
    // happens to name it.
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          requirementResults: [
            req({ provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["E1", "EX"] } }),
          ],
        },
        componentResults: [
          componentRow({ supportingEvidenceIds: ["E1"], excludedEvidence: [{ evidenceId: "EX", reason: "RELATIONSHIP_NOT_SUPPORTING" }] }),
        ],
        existingEvidenceIds: ["E1", "EX"],
      }),
    );
    expect(out.proof?.citedEvidenceIds).toEqual(["E1"]);
  });

  it("a claim with no resolvable evidence cites nothing and says so", () => {
    const out = buildProof(
      input({
        componentResults: [componentRow({ supportingEvidenceIds: [] })],
        existingEvidenceIds: [],
      }),
    );
    expect(out.proof?.citedEvidenceIds).toEqual([]);
    expect(layerOf(out, 3).lines.join(" ")).toContain("No evidence row is cited");
    expect(layerOf(out, 7).lines.join(" ")).toContain("No evidence is cited");
  });
});

describe("layers: the locked shape, and the mandatory block", () => {
  it("all seven canonical layers are present, in order, with their locked titles", () => {
    const out = buildProof(input());
    const layers = out.proof!.layers;
    expect(layers.version).toBe(PROOF_LAYERS_VERSION);
    expect(layers.layers.map((l) => l.layer)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(layers.layers.map((l) => l.title)).toEqual([...PROOF_LAYER_TITLES]);
  });

  it("layer 5 is deliberately EMPTY (D-083) and is never padded", () => {
    for (const status of ["SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      const out = buildProof(input({ claimSupport: { ...input().claimSupport!, status } }));
      expect(layerOf(out, 5).lines).toEqual([]);
    }
  });

  it("layer 6 is populated from REAL recorded gaps — blocking, context, component reasons and exclusions", () => {
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "PARTIALLY_SUPPORTED",
          requirementResults: [
            req({
              status: "PARTIAL",
              blockingGaps: [{ flowId: "f1", kind: "MISSING_COMPONENT", component: "FLOW_PATH", afterStep: 5 }],
            }),
          ],
          contextGaps: [{ flowId: null, kind: "FLOW_ENUMERATION_INCOMPLETE", component: null, afterStep: 3 }],
        },
        componentResults: [
          componentRow({
            status: "PARTIALLY_SUPPORTED",
            reasonCodes: ["INSUFFICIENT_AUTHORITY"],
            excludedEvidence: [{ evidenceId: "EX", reason: "RELATIONSHIP_NOT_SUPPORTING" }],
          }),
        ],
      }),
    );
    const origins = out.proof!.gaps.map((g) => g.origin);
    expect(origins).toContain("REQUIREMENT_BLOCKING");
    expect(origins).toContain("CLAIM_CONTEXT");
    expect(origins).toContain("COMPONENT_REASON");
    expect(origins).toContain("COMPONENT_EXCLUSION");
    const text = layerOf(out, 6).lines.join(" | ");
    expect(text).toContain("MISSING_COMPONENT");
    expect(text).toContain("FLOW_ENUMERATION_INCOMPLETE");
    expect(text).toContain("INSUFFICIENT_AUTHORITY");
    expect(text).toContain("RELATIONSHIP_NOT_SUPPORTING");
    // Not filler: every line traces to a recorded kind.
    expect(layerOf(out, 6).lines).toHaveLength(out.proof!.gaps.length);
  });

  it("layer 6 is non-empty whenever material gaps exist, and empty only when nothing is unresolved", () => {
    const withGaps = buildProof(
      input({
        componentResults: [componentRow({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] })],
      }),
    );
    expect(layerOf(withGaps, 6).lines.length).toBeGreaterThan(0);

    const clean = buildProof(input());
    expect(layerOf(clean, 6).lines).toEqual([]);
  });

  it("a SUPPORTED component contributes no gap, but a non-SUPPORTED one always does", () => {
    const out = buildProof(
      input({
        componentResults: [
          componentRow({ status: "SUPPORTED", reasonCodes: [] }),
          componentRow({ step: 1, component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }),
        ],
      }),
    );
    expect(out.proof!.gaps.map((g) => g.component)).toEqual(["SOURCE_OF_VALUE"]);
  });

  it("layer 1 states the verdict, the band, its encoding and what bound it — never a percentage", () => {
    const out = buildProof(input());
    const l1 = layerOf(out, 1).lines.join(" ");
    expect(l1).toContain("Verdict: SUPPORTED");
    expect(l1).toContain("Confidence: VERY_STRONG");
    expect(l1).toContain("band encoding 80");
    expect(l1).toContain("not a probability");
    expect(l1).toContain("Confidence bounded by: VERDICT_CEILING");
    // 15. the score is never formatted as a percentage, anywhere.
    expect(JSON.stringify(out.proof)).not.toContain("%");
  });
});

describe("the builder is a projection: pure, deterministic, and silent about what it was not told", () => {
  it("the same input yields a byte-identical draft", () => {
    const a = buildProof(input());
    const b = buildProof(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("16. confidence never changes the verdict — the two are computed independently", () => {
    // The weakest possible confidence still leaves a SUPPORTED verdict
    // SUPPORTED, and the strongest leaves INSUFFICIENT_EVIDENCE alone.
    const weak = buildProof(
      input({ componentResults: [componentRow({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] })] }),
    );
    expect(weak.proof!.verdict).toBe("SUPPORTED");
    expect(weak.proof!.confidenceScore).toBe(20);

    const strong = buildProof(
      input({ claimSupport: { ...input().claimSupport!, status: "INSUFFICIENT_EVIDENCE" } }),
    );
    expect(strong.proof!.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(strong.proof!.confidenceScore).toBe(60);
  });

  it("carries no free text: layer content is templated from recorded values only", () => {
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "NOT_SUPPORTED",
          reasonCodes: ["DESTINATION_MISMATCH"],
          requirementResults: [req({ status: "CONTRADICTED", reasonCodes: ["DESTINATION_MISMATCH"] })],
        },
      }),
    );
    const all = out.proof!.layers.layers.flatMap((l) => l.lines).join(" ");
    // Every distinctive token in the output traces to an input value.
    expect(all).toContain("NOT_SUPPORTED");
    expect(all).toContain("DESTINATION_MISMATCH");
    expect(all).toContain("R1");
    // And nothing editorial leaked in.
    for (const banned of ["likely", "probably", "we believe", "suggests", "strongly", "clearly"]) {
      expect(all.toLowerCase(), `layer text contains "${banned}"`).not.toContain(banned);
    }
  });

  it("names no project, host or mechanism of its own", () => {
    const out = buildProof(input());
    const all = JSON.stringify(out).toLowerCase();
    for (const banned of ["raydium", "pump", "solscan", "buyback", "burn", "treasury"]) {
      expect(all, `draft mentions "${banned}"`).not.toContain(banned);
    }
  });
});

// ---- the real persisted Raydium shapes, as offline fixtures -----------
//
// These reproduce the SHAPES the three Raydium DESTINATION jobs actually
// hold (documentary SUPPORTED, chain PARTIALLY_SUPPORTED, and the
// all-excluded one). Nothing is fetched and no verdict is re-decided —
// the point is that each already-recorded state yields the honest Proof
// it implies.
describe("D-135 acceptance: the five ratified fixture cases", () => {
  it("A. clean documentary SUPPORTED -> 80 / VERY_STRONG", () => {
    const out = buildProof(
      input({
        componentResults: [componentRow({ status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["doc-1"] })],
        claimSupport: {
          ...input().claimSupport!,
          status: "SUPPORTED",
          requirementResults: [req({ provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["doc-1"] } })],
        },
        existingEvidenceIds: ["doc-1"],
      }),
    );
    expect(out.proof!.verdict).toBe("SUPPORTED");
    expect(out.proof!.confidenceScore).toBe(80);
    expect(out.proof!.confidenceBand).toBe("VERY_STRONG");
  });

  it("B. authority-limited PARTIALLY_SUPPORTED (ONCHAIN_VERIFIABLE / CLAIMED) -> 60 / STRONG", () => {
    const out = buildProof(
      input({
        claimSupport: { ...input().claimSupport!, status: "PARTIALLY_SUPPORTED", requirementResults: [req({ status: "PARTIAL" })] },
        componentResults: [
          componentRow({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["chain-1"] }),
        ],
        existingEvidenceIds: ["chain-1"],
      }),
    );
    expect(out.proof!.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(out.proof!.confidenceScore).toBe(60);
    expect(out.proof!.confidenceBand).toBe("STRONG");
    expect(out.proof!.confidenceBindingReasons).toContain("INSUFFICIENT_AUTHORITY");
  });

  it("C. ALL_EVIDENCE_EXCLUDED with a required blocking gap -> 40 / LIMITED", () => {
    const excluded = ["x1", "x2", "x3", "x4", "x5", "x6"];
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "INSUFFICIENT_EVIDENCE",
          requirementResults: [
            req({
              status: "UNSATISFIED",
              blockingGaps: [{ flowId: null, kind: "MISSING_COMPONENT", component: "DESTINATION", afterStep: 6 }],
              provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: excluded },
            }),
          ],
        },
        componentResults: [
          componentRow({
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
            supportingEvidenceIds: [],
            excludedEvidence: excluded.map((id) => ({ evidenceId: id, reason: "RELATIONSHIP_NOT_SUPPORTING" })),
          }),
        ],
        existingEvidenceIds: excluded,
      }),
    );
    expect(out.proof!.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.proof!.confidenceScore).toBe(40);
    expect(out.proof!.confidenceBand).toBe("LIMITED");
    expect(out.proof!.confidenceBindingReasons).toContain("REQUIRED_BLOCKING_GAP");
    expect(out.proof!.citedEvidenceIds).toEqual([]);
  });

  it("D. NO_EVIDENCE_FOUND -> 20 / LOW", () => {
    const out = buildProof(
      input({
        claimSupport: { ...input().claimSupport!, status: "INSUFFICIENT_EVIDENCE", requirementResults: [req({ status: "UNSATISFIED" })] },
        componentResults: [
          componentRow({ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [] }),
        ],
        existingEvidenceIds: [],
      }),
    );
    expect(out.proof!.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.proof!.confidenceScore).toBe(20);
    expect(out.proof!.confidenceBand).toBe("LOW");
  });

  it("E. strong NOT_SUPPORTED from positive contradiction, confirmed authority, no limiting gaps -> 80 / VERY_STRONG", () => {
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "NOT_SUPPORTED",
          reasonCodes: ["DESTINATION_MISMATCH"],
          requirementResults: [
            req({
              status: "CONTRADICTED",
              reasonCodes: ["DESTINATION_MISMATCH"],
              provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["doc-1"] },
            }),
          ],
        },
        componentResults: [
          componentRow({ status: "CONTRADICTED", reasonCodes: [], supportingEvidenceIds: ["doc-1"] }),
        ],
        existingEvidenceIds: ["doc-1"],
      }),
    );
    expect(out.proof!.verdict).toBe("NOT_SUPPORTED");
    expect(out.proof!.confidenceScore).toBe(80);
    expect(out.proof!.confidenceBand).toBe("VERY_STRONG");
    // The contradiction IS the finding, so it does not cap its own verdict.
    expect(out.proof!.confidenceBindingReasons).toEqual(["VERDICT_CEILING"]);
  });
});

describe("existing persisted states produce the Proof they imply", () => {
  it("a documentary SUPPORTED component under a SUPPORTED claim yields SUPPORTED with citations and no gaps", () => {
    const out = buildProof(
      input({
        componentResults: [componentRow({ status: "SUPPORTED", supportingEvidenceIds: ["doc-1"] })],
        claimSupport: {
          ...input().claimSupport!,
          status: "SUPPORTED",
          requirementResults: [req({ provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: ["doc-1"] } })],
        },
        existingEvidenceIds: ["doc-1"],
      }),
    );
    expect(out.proof!.verdict).toBe("SUPPORTED");
    expect(out.proof!.citedEvidenceIds).toEqual(["doc-1"]);
    expect(layerOf(out, 6).lines).toEqual([]);
  });

  it("the chain PARTIALLY_SUPPORTED / INSUFFICIENT_AUTHORITY state surfaces the authority ceiling as a gap", () => {
    const out = buildProof(
      input({
        claimSupport: { ...input().claimSupport!, status: "PARTIALLY_SUPPORTED", requirementResults: [req({ status: "PARTIAL" })] },
        componentResults: [
          componentRow({ status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["chain-1"] }),
        ],
        existingEvidenceIds: ["chain-1"],
      }),
    );
    expect(out.proof!.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(layerOf(out, 6).lines.join(" ")).toContain("INSUFFICIENT_AUTHORITY");
  });

  it("the ALL_EVIDENCE_EXCLUDED state cites nothing and explains why — absence never becomes support", () => {
    const excluded = ["x1", "x2", "x3", "x4", "x5", "x6"];
    const out = buildProof(
      input({
        claimSupport: {
          ...input().claimSupport!,
          status: "INSUFFICIENT_EVIDENCE",
          requirementResults: [req({ status: "UNSATISFIED", provenance: { flowIds: [], componentResultKeys: [{ step: 6, component: "DESTINATION" }], evidenceIds: excluded } })],
        },
        componentResults: [
          componentRow({
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["ALL_EVIDENCE_EXCLUDED"],
            supportingEvidenceIds: [],
            excludedEvidence: excluded.map((id) => ({ evidenceId: id, reason: "RELATIONSHIP_NOT_SUPPORTING" })),
          }),
        ],
        existingEvidenceIds: excluded,
      }),
    );
    expect(out.proof!.verdict).toBe("INSUFFICIENT_EVIDENCE");
    // Six rows exist for the job, and NONE is cited as support.
    expect(out.proof!.citedEvidenceIds).toEqual([]);
    const l6 = layerOf(out, 6).lines.join(" ");
    expect(l6).toContain("ALL_EVIDENCE_EXCLUDED");
    expect(l6).toContain("RELATIONSHIP_NOT_SUPPORTING");
    expect(layerOf(out, 4).lines.join(" ")).toContain("excluded by component reconciliation");
  });
});
