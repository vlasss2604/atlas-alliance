import { describe, expect, it } from "vitest";

import type { AdmittedLocator } from "../src/server/engine/documentary-locator-store";
import {
  deriveDestinationBoundBurn,
  DESTINATION_BOUND_BURN_DOES_NOT_PROVE,
  MAX_DERIVATION_PATH_EDGES,
  type DerivationEdge,
  type DestinationBoundBurnOutcome,
} from "../src/server/engine/onchain-destination-bound-burn";
import { ALLOWED_DERIVATION_METHODS } from "../src/server/engine/onchain-subject-provenance";
import { MAX_PROMOTION_DEPTH } from "../src/server/engine/onchain-subject-promotion";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";

// DESTINATION-BOUND BURN — structural association, proved by the path.
//
// The claim under test is narrow on purpose: the account a burn destroyed
// tokens FROM is reachable, through THIS job's own recorded derivation
// steps, from an address a first-party document of this job named. Not
// attribution, not acquisition, not causality — a previous diagnostic's
// ATTRIBUTED naming was refused, and these tests exist mostly to pin the
// ways the association must FAIL rather than the one way it holds.

const MINT = "Mint1111111111111111111111111111111111111111";
const OTHER_MINT = "Mint2222222222222222222222222222222222222222";
const DESTINATION = "Dest1111111111111111111111111111111111111111";
const OTHER_DEST = "Dest2222222222222222222222222222222222222222";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const JOB = "11111111-1111-1111-1111-111111111111";
const OTHER_JOB = "22222222-2222-2222-2222-222222222222";

function burnRef(over: Partial<BurnInstructionRef> = {}): BurnInstructionRef {
  return {
    programId: "TokenProg1111111111111111111111111111111111",
    instructionType: "BurnChecked",
    mint: MINT,
    sourceAccount: TOKEN_ACCOUNT,
    authority: WALLET,
    amountRaw: "7723746661",
    decimals: 6,
    ...over,
  } as BurnInstructionRef;
}

// The TRANSACTION_DETAIL observation, branded exactly as the adapter brands
// one — so the burn's provenance is the artifact's own, not a copy.
function txArtifact(
  over: { burns?: BurnInstructionRef[]; anchor?: string; chain?: string; network?: string } = {},
): OnchainArtifact {
  const anchor = over.anchor ?? MINT;
  const chain = over.chain ?? "solana";
  const network = over.network ?? "mainnet";
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: chain as OnchainIntent["chain"],
    network: network as OnchainIntent["network"],
    projectAnchor: anchor,
    subjectKind: "tx",
    subject: SIGNATURE,
  };
  const result = {
    kind: "TRANSACTION_DETAIL" as const,
    signature: SIGNATURE,
    slot: 441_840_980,
    blockTime: 1_700_000_000,
    succeeded: true,
    burns: over.burns ?? [burnRef()],
    programs: [],
    accountKeys: [WALLET, MINT, TOKEN_ACCOUNT],
    tokenInstructions: [],
    lifecycleInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: chain as OnchainArtifact["provenance"]["chain"],
      network: network as OnchainArtifact["provenance"]["network"],
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: SIGNATURE,
      slot: 441_840_980,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "solana-mainnet-rpc",
      providerMethod: "getTransaction",
      requestParams: { subject: SIGNATURE },
      transactionSignature: SIGNATURE,
      retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
      rawResponseHash: "sha256:raw:tx",
      artifactHash: "sha256:art:tx",
    },
  });
}

let edgeSeq = 0;
function edge(parentSubject: string, subject: string, over: Partial<DerivationEdge> = {}): DerivationEdge {
  edgeSeq += 1;
  return {
    parentSubject,
    subject,
    subjectKind: "TOKEN_ACCOUNT",
    derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    bindingStatus: "CONFIRMED",
    onchainArtifactId: `artifact-${edgeSeq}`,
    researchJobId: JOB,
    observedSlot: 441_840_900 + edgeSeq,
    ...over,
  };
}

function destination(value: string, over: Partial<AdmittedLocator> = {}): AdmittedLocator {
  return {
    value,
    shape: "ADDRESS_LIKE",
    evidenceId: `evidence-${value}`,
    sourceId: `source-${value}`,
    researchJobId: JOB,
    ...over,
  };
}

function derive(over: {
  artifact?: OnchainArtifact;
  burnIndex?: number;
  researchJobId?: string | null;
  edges?: DerivationEdge[];
  admittedDestinations?: AdmittedLocator[];
}): DestinationBoundBurnOutcome {
  return deriveDestinationBoundBurn({
    artifact: over.artifact ?? txArtifact(),
    burnIndex: over.burnIndex ?? 0,
    researchJobId: over.researchJobId === undefined ? JOB : over.researchJobId,
    edges: over.edges ?? [],
    admittedDestinations: over.admittedDestinations ?? [destination(DESTINATION)],
  });
}

function refusal(outcome: DestinationBoundBurnOutcome) {
  return outcome.bound ? null : outcome.reason;
}

// ---------------------------------------------------------------------
// 1/2 — the association holds.
// ---------------------------------------------------------------------

describe("1/2. a burn reachable from an admitted destination", () => {
  it("1. one derivation hop: documented destination -> token account -> burn", () => {
    const out = derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT)] });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.sourceAccount).toBe(TOKEN_ACCOUNT);
    expect(out.result.mint).toBe(MINT);
    expect(out.result.root.address).toBe(DESTINATION);
    expect(out.result.root.evidenceId).toBe(`evidence-${DESTINATION}`);
    expect(out.result.hops).toBe(1);
    expect(out.result.researchJobId).toBe(JOB);
    // The burn's own provenance survives, so the observation is re-verifiable.
    expect(out.result.signature).toBe(SIGNATURE);
    expect(out.result.artifactHash).toBe("sha256:art:tx");
    expect(out.result.instructionType).toBe("BurnChecked");
    expect(out.result.amountRaw).toBe("7723746661");
  });

  it("2. multiple hops, within the bound", () => {
    const middle = "Mid11111111111111111111111111111111111111111";
    const out = derive({
      edges: [edge(DESTINATION, middle), edge(middle, TOKEN_ACCOUNT)],
    });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.hops).toBe(2);
    expect(out.result.root.address).toBe(DESTINATION);
  });

  it("zero hops: a documented address that IS the burning token account", () => {
    // The promotion rules explicitly stop at a locator that is itself a
    // token account for the mint, so this path is real and must not need a
    // derivation row to exist.
    const artifact = txArtifact({ burns: [burnRef({ sourceAccount: DESTINATION })] });
    const out = derive({ artifact, edges: [] });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.hops).toBe(0);
    expect(out.result.path).toEqual([]);
    expect(out.result.root.address).toBe(DESTINATION);
  });
});

// ---------------------------------------------------------------------
// 3-13 — every way it must fail closed.
// ---------------------------------------------------------------------

describe("3/4. reachability is directional, not incidental", () => {
  it("3. a burn source with no path to any admitted destination is refused", () => {
    expect(refusal(derive({ edges: [edge(OTHER_DEST, TOKEN_ACCOUNT)] }))).toBe(
      "NO_DERIVATION_PATH",
    );
  });

  it("4. THE SAME ADDRESSES IN THE WRONG DIRECTION prove nothing", () => {
    // parent and child swapped: the destination is recorded as derived FROM
    // the token account. Walking child -> parent from the burn source finds
    // no edge whose subject is the burn source, so no path exists.
    expect(refusal(derive({ edges: [edge(TOKEN_ACCOUNT, DESTINATION)] }))).toBe(
      "NO_DERIVATION_PATH",
    );
  });

  it("an edge that derives a subject from itself is malformed", () => {
    expect(
      refusal(derive({ edges: [edge(TOKEN_ACCOUNT, TOKEN_ACCOUNT)] })),
    ).toBe("MALFORMED_DERIVATION_EDGE");
  });
});

describe("5/6/7/8. the path may not leave this job, project, chain or network", () => {
  it("5. an edge from another research job is refused", () => {
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { researchJobId: OTHER_JOB })] })),
    ).toBe("CROSS_JOB_PATH");
  });

  it("5b. an edge from a standalone observation has no job boundary at all", () => {
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { researchJobId: null })] })),
    ).toBe("CROSS_JOB_PATH");
  });

  it("5c. a burn observation with no job boundary is refused before any traversal", () => {
    expect(
      refusal(derive({ researchJobId: null, edges: [edge(DESTINATION, TOKEN_ACCOUNT)] })),
    ).toBe("NO_PROVENANCE_BOUNDARY");
  });

  it("5d. a destination admitted by ANOTHER job is not a destination here", () => {
    expect(
      refusal(
        derive({
          edges: [edge(DESTINATION, TOKEN_ACCOUNT)],
          admittedDestinations: [destination(DESTINATION, { researchJobId: OTHER_JOB })],
        }),
      ),
    ).toBe("ROOT_NOT_ADMITTED");
  });

  it("6. an edge bound to another project anchor is refused", () => {
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { projectAnchor: OTHER_MINT })] })),
    ).toBe("CROSS_PROJECT_PATH");
  });

  it("7. a chain mismatch on the path is refused", () => {
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { chain: "ethereum" })] })),
    ).toBe("CHAIN_MISMATCH");
  });

  it("8. a network mismatch on the path is refused", () => {
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { network: "devnet" })] })),
    ).toBe("NETWORK_MISMATCH");
  });

  it("an unlisted derivation method, or an unconfirmed binding, may not be followed", () => {
    expect(
      refusal(
        derive({
          edges: [edge(DESTINATION, TOKEN_ACCOUNT, { derivationMethod: "SIGNATURES_FOR_ADDRESS" })],
        }),
      ),
    ).toBe("MALFORMED_DERIVATION_EDGE");
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { bindingStatus: "UNVERIFIED" })] })),
    ).toBe("MALFORMED_DERIVATION_EDGE");
  });
});

describe("9/10. the burn itself must be the right kind of event", () => {
  it("9. a burn of another mint is not this project's supply event", () => {
    const artifact = txArtifact({ burns: [burnRef({ mint: OTHER_MINT })] });
    expect(refusal(derive({ artifact, edges: [edge(DESTINATION, TOKEN_ACCOUNT)] }))).toBe(
      "MINT_MISMATCH",
    );
  });

  it("10. a missing burn, or a burn with no source account, is refused", () => {
    expect(refusal(derive({ artifact: txArtifact({ burns: [] }) }))).toBe("MISSING_BURN_SOURCE");
    expect(refusal(derive({ burnIndex: 7 }))).toBe("MISSING_BURN_SOURCE");
    const artifact = txArtifact({ burns: [burnRef({ sourceAccount: "" })] });
    expect(refusal(derive({ artifact }))).toBe("MISSING_BURN_SOURCE");
  });

  it("a non-transaction observation is refused by kind", () => {
    const intent: OnchainIntent = {
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "token",
      subject: MINT,
    };
    const supply = brandOnchainArtifact({
      intent,
      canonicalUri: buildCanonicalOnchainUri(intent),
      result: { kind: "TOKEN_SUPPLY", mint: MINT, amountRaw: "1000", decimals: 6 },
      normalizedText: "{}",
      provenance: { ...txArtifact().provenance, subjectKind: "token", subject: MINT },
    });
    expect(refusal(derive({ artifact: supply }))).toBe("WRONG_FACT_KIND");
  });

  it("no admitted destination at all is a distinct refusal", () => {
    expect(refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT)], admittedDestinations: [] }))).toBe(
      "ROOT_NOT_ADMITTED",
    );
  });
});

describe("11/12/13. malformed graphs fail closed rather than resolve", () => {
  it("11. a cycle in the derivation graph is refused", () => {
    const a = "Cyc11111111111111111111111111111111111111111";
    const out = derive({
      edges: [edge(a, TOKEN_ACCOUNT), edge(TOKEN_ACCOUNT, a)],
    });
    expect(refusal(out)).toBe("CYCLIC_PATH");
  });

  it("12. a path longer than the authorised derivation depth is refused", () => {
    // The bound is reused, never chosen: acquisition may promote a subject
    // at most MAX_PROMOTION_DEPTH times, so a longer stored chain was not
    // produced by the bounded acquisition path.
    expect(MAX_DERIVATION_PATH_EDGES).toBe(MAX_PROMOTION_DEPTH);
    const chain: DerivationEdge[] = [];
    let child = TOKEN_ACCOUNT;
    for (let i = 0; i < MAX_DERIVATION_PATH_EDGES + 1; i++) {
      const parent = `Hop${String(i).padStart(41, "1")}`;
      chain.push(edge(parent, child));
      child = parent;
    }
    // The far end IS admitted — it is simply further than the bound allows.
    const out = derive({ edges: chain, admittedDestinations: [destination(child)] });
    expect(refusal(out)).toBe("PATH_DEPTH_EXCEEDED");
  });

  it("12b. exactly at the bound still succeeds", () => {
    const chain: DerivationEdge[] = [];
    let child = TOKEN_ACCOUNT;
    for (let i = 0; i < MAX_DERIVATION_PATH_EDGES; i++) {
      const parent = `Hop${String(i).padStart(41, "1")}`;
      chain.push(edge(parent, child));
      child = parent;
    }
    const out = derive({ edges: chain, admittedDestinations: [destination(child)] });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.hops).toBe(MAX_DERIVATION_PATH_EDGES);
  });

  it("13. two distinct parents for the same subject is ambiguous, never resolved", () => {
    const out = derive({
      edges: [edge(DESTINATION, TOKEN_ACCOUNT), edge(OTHER_DEST, TOKEN_ACCOUNT)],
      admittedDestinations: [destination(DESTINATION), destination(OTHER_DEST)],
    });
    expect(refusal(out)).toBe("AMBIGUOUS_ROOT");
  });

  it("13b. an address that is BOTH an admitted destination and derived from one is ambiguous", () => {
    const artifact = txArtifact({ burns: [burnRef({ sourceAccount: DESTINATION })] });
    const out = derive({
      artifact,
      edges: [edge(OTHER_DEST, DESTINATION)],
      admittedDestinations: [destination(DESTINATION), destination(OTHER_DEST)],
    });
    expect(refusal(out)).toBe("AMBIGUOUS_ROOT");
  });

  it("13c. the same address admitted by two different Evidence rows is ambiguous", () => {
    const out = derive({
      edges: [edge(DESTINATION, TOKEN_ACCOUNT)],
      admittedDestinations: [
        destination(DESTINATION, { evidenceId: "evidence-a" }),
        destination(DESTINATION, { evidenceId: "evidence-b" }),
      ],
    });
    expect(refusal(out)).toBe("AMBIGUOUS_ROOT");
  });

  it("duplicate identical rows for one edge are not ambiguity", () => {
    const out = derive({
      edges: [
        edge(DESTINATION, TOKEN_ACCOUNT, { onchainArtifactId: "artifact-x" }),
        edge(DESTINATION, TOKEN_ACCOUNT, { onchainArtifactId: "artifact-y" }),
      ],
    });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.hops).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 14 — the path IS the proof.
// ---------------------------------------------------------------------

describe("14. the exact ordered path is preserved", () => {
  it("reports root -> ... -> burn source, with each step's own provenance", () => {
    const middle = "Mid11111111111111111111111111111111111111111";
    const first = edge(DESTINATION, middle, { onchainArtifactId: "artifact-first" });
    const second = edge(middle, TOKEN_ACCOUNT, { onchainArtifactId: "artifact-second" });
    // Supplied out of order on purpose: traversal follows the graph, never
    // the array.
    const out = derive({ edges: [second, first] });
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    expect(out.result.path).toEqual([
      {
        parentSubject: DESTINATION,
        subject: middle,
        subjectKind: "TOKEN_ACCOUNT",
        derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
        onchainArtifactId: "artifact-first",
        observedSlot: first.observedSlot,
      },
      {
        parentSubject: middle,
        subject: TOKEN_ACCOUNT,
        subjectKind: "TOKEN_ACCOUNT",
        derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER",
        onchainArtifactId: "artifact-second",
        observedSlot: second.observedSlot,
      },
    ]);
    // The path is contiguous: each step's parent is the previous step's
    // subject, ending at the account the burn actually names.
    expect(out.result.path[0].parentSubject).toBe(out.result.root.address);
    expect(out.result.path[1].subject).toBe(out.result.sourceAccount);
  });
});

// ---------------------------------------------------------------------
// 15/16/17 — what the module must not be.
// ---------------------------------------------------------------------

describe("15/16/17. structural only, pure, and reachable from nothing", () => {
  it("15. no model judgment and no lexical matching anywhere", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-destination-bound-burn.ts", "utf-8");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const banned of [
      "includes(",
      "indexOf(",
      "startsWith",
      "endsWith",
      "toLowerCase",
      "match(",
      "RegExp",
      "anthropic",
      "prompt",
      "model",
    ]) {
      expect(code, `structural derivation must not use ${banned}`).not.toContain(banned);
    }
    // Address comparison is exact equality only.
    expect(code).not.toContain("~");
    expect(code).not.toContain("LIKE");
  });

  it("16. no database import and no query in the pure module", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-destination-bound-burn.ts", "utf-8");
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const banned of [
      "drizzle-orm",
      'from "../db/',
      'from "./providers/onchain-retriever"',
      ".select(",
      ".insert(",
      ".update(",
      ".execute(",
      "sql`",
    ]) {
      expect(code, `pure module must not reference ${banned}`).not.toContain(banned);
    }
    // The one type it borrows from a database-touching module is imported
    // as a TYPE, so nothing enters the runtime graph.
    expect(raw).toContain('import type { AdmittedLocator } from "./documentary-locator-store";');
    expect(raw).not.toContain('import { AdmittedLocator }');
  });

  it("17. nothing in src or scripts imports this capability", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const files = [...(await walk("src")), ...(await walk("scripts"))];
    const importers: string[] = [];
    for (const f of files) {
      if (f.endsWith("onchain-destination-bound-burn.ts")) continue;
      const src = await readFile(f, "utf-8");
      if (src.includes("onchain-destination-bound-burn")) importers.push(f);
    }
    // Not reconciliation, not Evidence persistence, not applicability, not
    // acquisition — the derivation capability exists and is wired to nothing.
    expect(importers).toEqual([]);
  });

  it("no persisted fact kind was created for it, and applicability is unchanged", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).not.toContain("DESTINATION_BOUND");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    const raw = await readFile("src/server/engine/onchain-destination-bound-burn.ts", "utf-8");
    const src = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toContain("onchainFactKind");
    expect(src).not.toContain("NET_EFFECT");
    // The refused name appears in no identifier, type or exported string —
    // only in the comment recording that it was refused.
    expect(src).not.toContain("ATTRIBUTED");
    expect(src).not.toContain("Attributed");
    expect(raw).toContain("That word was refused");
  });

  it("the local method allowlist matches the canonical one exactly", async () => {
    // Restated rather than imported, because the canonical module reaches
    // the database at runtime. Drift must therefore fail here.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-destination-bound-burn.ts", "utf-8");
    for (const method of ALLOWED_DERIVATION_METHODS) {
      expect(src).toContain(`"${method}"`);
    }
    expect([...ALLOWED_DERIVATION_METHODS]).toEqual(["TOKEN_ACCOUNTS_BY_OWNER"]);
    // And nothing beyond that set is followable.
    expect(
      refusal(derive({ edges: [edge(DESTINATION, TOKEN_ACCOUNT, { derivationMethod: "ACCOUNT_INFO" })] })),
    ).toBe("MALFORMED_DERIVATION_EDGE");
  });

  it("no project, asset or mechanism is named", async () => {
    const { readFile } = await import("node:fs/promises");
    const lower = (
      await readFile("src/server/engine/onchain-destination-bound-burn.ts", "utf-8")
    ).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
    const codeOnly = lower
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(/["'][1-9a-hj-np-za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });

  it("the semantic ceiling is stated on the module itself", () => {
    for (const phrase of [
      "does NOT establish that the burned tokens were purchased",
      "does NOT establish that protocol revenue funded them",
      "does NOT establish that the mechanism caused the burn",
      "net deflation",
      "holder value accrual",
    ]) {
      expect(DESTINATION_BOUND_BURN_DOES_NOT_PROVE).toContain(phrase);
    }
  });
});
