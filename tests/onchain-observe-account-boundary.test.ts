import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import type { OnchainArtifact } from "../src/server/engine/providers/onchain-types";

// BOUNDED PERSISTING ACCOUNT OBSERVATION — structural guarantees.
//
// This entrypoint performs a real, billable, externally-visible chain read
// AND writes Evidence. Its safety argument is therefore two-sided: what it
// cannot do (one intent, one read, no retry, no escalation, no search, no
// model), and what it cannot author (every Evidence property comes from
// production synthesis/persistence, never from the command line).

const ENTRYPOINT = new URL("../scripts/onchain-observe-account.ts", import.meta.url);

async function source(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(ENTRYPOINT, "utf-8");
}

async function code(): Promise<string> {
  const raw = await source();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("observe-account — exactly one bounded read (items 3-11)", () => {
  it("3/4/5. ONE subject, ONE ACCOUNT_INFO intent, ONE retrieval, ONE retriever", async () => {
    const c = await code();
    expect((c.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
    expect((c.match(/const intent: OnchainIntent = \{/g) ?? []).length).toBe(1);
    expect((c.match(/createProductionOnchainRetriever\(/g) ?? []).length).toBe(1);
    // The intent kind is a module constant, not a parameter — an RPC method
    // must not be selectable from the command line.
    expect(c).toContain('const INTENT_KIND = "ACCOUNT_INFO" as const');
    expect(c).toContain("kind: INTENT_KIND");
    expect(c).toContain("subject: address");
  });

  it("4/8/9. cannot escalate to another intent, a scan, a transaction or owner discovery", async () => {
    const c = await code();
    for (const banned of [
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "TOKEN_ACCOUNT_BALANCE",
      "TOKEN_SUPPLY",
      "getSignaturesForAddress",
      "getTransaction",
      "getTokenAccountsByOwner",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("6/7. no retry, no loop around the read, no pagination cursor", async () => {
    const c = await code();
    for (const banned of ["retry", "attempt", "for (let i", "while (", "Promise.all", "cursor", "before:", "until:", "limit:"]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("10. never promotes an intent — the promotion module is not in its graph", async () => {
    const c = await code();
    for (const banned of ["onchain-subject-promotion", "promoteSubjects", "intentForPromotedSubject", "PromotedSubject"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("11. never enumerates the project's other admitted locators", async () => {
    const c = await code();
    for (const banned of ["admittedLocatorsForJob", "findAdmittedLocator", "eligibleSubjects", "selectOnchainIntents"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
    // The subject appears exactly twice — once in the gate, once in the
    // intent — and it is the same single CLI argument both times, never a
    // collection and never iterated.
    expect((c.match(/subject: address/g) ?? []).length).toBe(2);
    for (const banned of ["subjects", ".map(", "for (const s of", "locators"]) {
      expect(c, `entrypoint iterates subjects via "${banned}"`).not.toContain(banned);
    }
  });

  it("12/13/14. no search, no documentary fetch, no model call, no renderer", async () => {
    const c = await code();
    for (const banned of [
      "anthropic",
      "Anthropic",
      "evidence-extractor",
      "query-proposer",
      "search-gateway",
      "brave",
      "Brave",
      "content-fetcher",
      "ContentFetcher",
      "acquired_documents",
      "acquire-document",
      "playwright",
      "chromium",
      "rendered-docs",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("never invokes the broad S4 acquisition loop", async () => {
    const c = await code();
    for (const banned of [
      "s4-executor",
      "createS4WorkExecutor",
      "runStructuredOnchainAcquisition",
      "run-job",
      "controller",
      "mechanism-assembl",
      "claim-evaluator",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });
});

describe("observe-account — fail-closed gates (items 1, 2, 24)", () => {
  it("1. the subject must be admitted, and the gate runs BEFORE the retriever exists", async () => {
    const c = await code();
    expect(c).toContain("resolveOnchainSubject(db, {");
    expect(c).toContain("projectAnchor: anchor,");
    const gate = c.indexOf("refusing — this address has no admitted on-chain subject provenance");
    const retriever = c.indexOf("createProductionOnchainRetriever(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(retriever);
  });

  it("2. identity is required and supplies the anchor; the anchor is never a CLI argument", async () => {
    const c = await code();
    expect(c).toContain("resolveConfirmedIdentity(");
    expect(c).toContain("anchor = identity.tokenAddress");
    expect(c).toContain("no ACTIVE PROJECT_IDENTITY");
    expect(c).toContain("not solana");
    // No mint may be supplied: the only argv reads are the four named ones.
    expect(c).toContain("const [address, slug, component, stepRaw, ...rest] = process.argv.slice(2)");
  });

  it("24. malformed or unknown arguments are refused fail-closed", async () => {
    const c = await code();
    // Missing args, extra args, and a non-1..8 step are all refusals.
    expect(c).toContain("rest.length > 0");
    expect(c).toContain("!Number.isInteger(step) || step < 1 || step > 8");
    expect(c).toContain("unknown component");
    // Live-allowlist and alpha-enable gates, same as the other spending
    // owner entrypoints.
    expect(c).toContain("INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug)");
    expect(c).toContain("internal_alpha_enabled");
  });

  it("refuses a component the ACTIVE Pattern says a chain read cannot establish", async () => {
    const c = await code();
    expect(c).toContain('establishingClasses.includes("ONCHAIN_VERIFIABLE")');
    // The rule comes from the Pattern, not from a list in this script.
    expect(c).toContain("componentRequirementsFor(");
    // Sanity: the Pattern really does gate this way, and DESTINATION passes
    // while a non-chain component does not.
    expect(componentRequirementsFor(PATTERN_V1_CONTENT, "DESTINATION").establishingClasses).toContain(
      "ONCHAIN_VERIFIABLE",
    );
    expect(componentRequirementsFor(PATTERN_V1_CONTENT, "MECHANISM_SPEC").establishingClasses).not.toContain(
      "ONCHAIN_VERIFIABLE",
    );
  });

  it("16. binding is validated rather than assumed", async () => {
    const c = await code();
    expect(c).toContain("validateOnchainBinding(");
    const binding = c.indexOf("validateOnchainBinding(");
    const persist = c.indexOf("persistOnchainArtifactAndFacts(");
    expect(binding).toBeLessThan(persist);
  });
});

describe("observe-account — persistence is the production path (items 15, 17-21, 25)", () => {
  it("17/18/19/20. ONE production call writes artifact + facts + Evidence; nothing is hand-authored", async () => {
    const c = await code();
    expect((c.match(/persistOnchainArtifactAndFacts\(/g) ?? []).length).toBe(1);
    // The script never inserts evidence or artifacts itself, and never
    // authors a classification. Its only .insert is the job's user row.
    expect(c).not.toContain(".insert(evidence)");
    expect(c).not.toContain(".insert(onchainArtifacts)");
    expect((c.match(/\.insert\(/g) ?? []).length).toBe(1);
    expect(c).toContain(".insert(users)");
    // It never AUTHORS a classification or a fact sentence. Printing a
    // persisted row's fields back to the operator is not authoring, so the
    // console lines are excluded and the remaining code — where an object
    // literal would live — is what gets checked.
    const authored = c
      .split("\n")
      .filter((l) => !l.trim().startsWith("console."))
      .join("\n");
    for (const banned of [
      'sourceClass: "',
      'officiality: "',
      'entityBinding: "',
      'relationship: "',
      'directness: "',
      "summary: `",
      'summary: "',
      "statement: `",
      'statement: "',
      "doesNotProve: `",
      'doesNotProve: "',
    ]) {
      expect(authored, `entrypoint authors "${banned}"`).not.toContain(banned);
    }
    // The class names may appear ONLY as a read-side gate (does the Pattern
    // admit chain evidence for this component?) — never as a value assigned
    // to an Evidence field. The assignment forms above already cover that;
    // this pins the one legitimate occurrence so a future assignment stands
    // out rather than blending in.
    // Two legitimate occurrences only: the gate itself and the refusal
    // message that names it.
    expect((authored.match(/ONCHAIN_VERIFIABLE/g) ?? []).length).toBe(2);
    expect(authored).toContain('establishingClasses.includes("ONCHAIN_VERIFIABLE")');
    expect(authored).toContain("is not establishable by ONCHAIN_VERIFIABLE");
    expect(authored).not.toContain("CLAIMED");
    // It also never calls the synthesizer directly — the production
    // persistence path does that, so facts and Evidence cannot diverge.
    expect(c).not.toContain("synthesizeOnchainFacts(");
  });

  it("15/16. a failed read or a refused artifact writes no Evidence and runs no reconciliation", async () => {
    const c = await code();
    // A retrieval that throws propagates out of main() — there is no catch
    // around it that could continue to persistence.
    const retrieve = c.indexOf("retriever.retrieve(");
    const persist = c.indexOf("persistOnchainArtifactAndFacts(");
    expect(retrieve).toBeLessThan(persist);
    // A containment refusal exits before reconciliation.
    expect(c).toContain("stored.rejectedReason !== null || !stored.artifactId");
    const refusal = c.indexOf("no Evidence written, no reconciliation run");
    const reconcile = c.indexOf("reconcileAndPersistComponent(");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(reconcile);
  });

  it("21. reconciliation runs exactly once, only after persistence, scoped to this job", async () => {
    const c = await code();
    expect((c.match(/reconcileAndPersistComponent\(/g) ?? []).length).toBe(1);
    expect(c).toContain("reconcileAndPersistComponent(db, jobId, { step, component }, new Date())");
  });

  it("25. the job it creates is truthful: no document, no search, no model is claimed", async () => {
    const c = await code();
    expect(c).toContain("createResearchJob(");
    expect(c).toContain("skipEnqueue: true");
    // The job describes exactly this operation.
    expect(c).toContain("observe on-chain account");
    expect(c).toContain("perform one bounded ${INTENT_KIND} read of one admitted on-chain subject");
    // It never claims a document was fetched or a query searched. Scoped
    // to the job-description strings themselves — elsewhere the script
    // legitimately PRINTS the provenance class, which may be documentary.
    const question = c.slice(c.indexOf("originalQuestion:"), c.indexOf("normalizedTaskHash:")).toLowerCase();
    for (const banned of ["extract evidence from", "acquired document", "documentary", "search", "fetch", "model"]) {
      expect(question, `job description claims "${banned}"`).not.toContain(banned);
    }
    // And the budget it authorizes has zero on the axes it cannot spend.
    expect(c).toContain("maxSearchQueries: 0");
    expect(c).toContain("maxModelCostMicro: 0");
    // The header states WHY a job exists here while the derive sibling
    // refuses one — the distinction is Evidence, and it must stay written.
    const raw = await source();
    expect(raw).toContain("JOB HONESTY");
  });
});

describe("observe-account — research brakes (items 22, 23)", () => {
  it("22. NOT_TOKEN_PROGRAM_OWNED never becomes a claim about holdings", async () => {
    const c = await code();
    // The script cannot author any such sentence: it writes no fact text.
    for (const banned of ["no RAY", "does not hold", "holds no", "no token accounts", "contradicts"]) {
      expect(c, `entrypoint asserts "${banned}"`).not.toContain(banned);
    }
    // And the PRODUCTION synthesizer — the only thing that authors facts
    // here — says nothing about holdings for this result either.
    const artifact = {
      canonicalUri: "atlas-onchain://solana/mainnet/project/MINT/account/SUBJ/info",
      normalizedText: "",
      result: {
        kind: "ACCOUNT_INFO",
        address: "SUBJ",
        exists: true,
        ownerProgram: "11111111111111111111111111111111",
        executable: false,
        lamports: "7823801354",
        tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
        tokenAccount: null,
      },
      provenance: {
        chain: "solana",
        network: "mainnet",
        projectAnchor: "MINT",
        subject: "SUBJ",
        slot: 442384428,
        finality: "finalized",
        providerId: "solana-mainnet-rpc",
        providerMethod: "getAccountInfo",
        retrievedAt: new Date("2026-08-28T16:53:13.172Z"),
        rawResponseHash: "sha256:raw",
        artifactHash: "sha256:artifact",
      },
    } as unknown as OnchainArtifact;
    const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
    // Exactly ONE fact: existence + owning program. The negative relation
    // deliberately adds nothing — see onchain-facts.ts.
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toContain("exists on-chain and is owned by program");
    for (const banned of ["no RAY", "does not hold", "holds no", "burn", "buyback", "treasury"]) {
      expect(facts[0].statement.toLowerCase(), `synthesized statement implies "${banned}"`).not.toContain(
        banned.toLowerCase(),
      );
    }
    // The limit is stated explicitly rather than left to the reader.
    expect(facts[0].doesNotProve).toContain("economic labels, not chain facts");
    // A non-existent account yields NO fact at all — absence is not a fact.
    const absent = { ...artifact, result: { ...(artifact.result as object), exists: false } } as unknown as OnchainArtifact;
    expect(synthesizeOnchainFacts(absent, { step: 6, component: "DESTINATION" })).toHaveLength(0);
  });

  it("23. no project-specific string appears in the executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of [
      "raydium",
      "ray",
      "ddhdoz",
      "4k3dyj",
      "pump",
      "solscan",
      "buyback",
      "burn",
      "treasury",
      "hyperliquid",
      "uniswap",
    ]) {
      expect(c, `entrypoint code mentions "${banned}"`).not.toContain(banned);
    }
  });
});
