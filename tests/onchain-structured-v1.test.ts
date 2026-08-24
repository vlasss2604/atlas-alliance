import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  onchainArtifacts,
  projects,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  evaluateStructuredContainment,
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  persistOnchainArtifactAndFacts,
  runStructuredOnchainAcquisition,
  selectOnchainIntents,
} from "../src/server/engine/onchain-acquisition";
import { ONCHAIN_DOES_NOT_PROVE, synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri, parseCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  brandOnchainArtifact,
  type OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import {
  endpointEnvVarFor,
  isAcceptableEndpoint,
  OnchainRetrieverUnavailableError,
  resolveOnchainRetriever,
  type OnchainRpcTransport,
} from "../src/server/engine/providers/onchain-retriever";
import {
  createSolanaOnchainAdapter,
  MAX_SIGNATURES_PER_INTENT,
  SOLANA_ALLOWED_RPC_METHODS,
} from "../src/server/engine/providers/onchain-solana";
import {
  createHttpsRpcTransport,
  createProductionOnchainRetriever,
  OnchainTransportError,
} from "../src/server/engine/providers/onchain-transport";
import { deriveSourceType, resolveSourceClass } from "../src/server/engine/source-authority";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// STRUCTURED ON-CHAIN RETRIEVAL V1 — offline regression suite.
//
// ZERO network calls: every adapter test drives a recorded-fixture
// transport. No project-specific logic is exercised; all addresses below
// are synthetic base58 strings, and the one real-looking mint appears only
// where the owner's worked example requires it as DATA.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// Synthetic, valid-format base58 addresses (32-44 chars, no 0/O/I/l).
const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ACCOUNT = "AcctCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const SIGNATURE =
  "SigDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const identity: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };

// Fixtures mirror a REAL node: a JSON-RPC 2.0 envelope, not a bare
// result. An earlier cut of these tests passed bare payloads and hid the
// fact that the adapter never unwrapped the envelope.
function fixtureTransport(payload: unknown): OnchainRpcTransport {
  return { async call() { return JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }); } };
}

function adapterWith(payload: unknown) {
  return createSolanaOnchainAdapter({
    transport: fixtureTransport(payload),
    providerId: "fixture-rpc",
    finality: "finalized",
  });
}

const SUPPLY_PAYLOAD = { context: { slot: 100 }, value: { amount: "1000000", decimals: 6 } };

function supplyIntent(overrides: Partial<OnchainIntent> = {}): OnchainIntent {
  return {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    subjectKind: "token",
    subject: MINT,
    ...overrides,
  } as OnchainIntent;
}

async function makeJob(): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("oc"), name: "Onchain Test Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the mechanism reduce supply?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

describe("entity binding — artifact fields decide, never the URI", () => {
  it("the confirmed mint binds", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    expect(validateOnchainBinding(artifact, identity).binding).toBe("CONFIRMED");
  });

  it("a different mint fails", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(
      supplyIntent({ projectAnchor: OTHER_MINT, subject: OTHER_MINT }),
    );
    const out = validateOnchainBinding(artifact, identity);
    expect(out.binding).toBe("UNVERIFIED");
    expect(out).toMatchObject({ reason: "ANCHOR_NOT_PROJECT_IDENTITY" });
  });

  it("a different chain fails", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const evmIdentity: ConfirmedProjectIdentity = {
      chain: "ethereum",
      tokenAddress: MINT,
      ticker: "TST",
    } as ConfirmedProjectIdentity;
    expect(validateOnchainBinding(artifact, evmIdentity)).toMatchObject({
      binding: "UNVERIFIED",
      reason: "CHAIN_MISMATCH",
    });
  });

  it("a non-production network fails, and the adapter refuses to serve one at all", async () => {
    await expect(
      adapterWith(SUPPLY_PAYLOAD).retrieve(
        supplyIntent({ network: "devnet" as OnchainIntent["network"] }),
      ),
    ).rejects.toThrow(OnchainRetrieverUnavailableError);

    // And even if an artifact somehow carried one, binding refuses it.
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const testnet = brandOnchainArtifact({
      ...artifact,
      provenance: { ...artifact.provenance, network: "devnet" as never },
    });
    expect(validateOnchainBinding(testnet, identity)).toMatchObject({
      binding: "UNVERIFIED",
      reason: "NETWORK_NOT_PRODUCTION",
    });
  });

  it("no confirmed identity fails closed", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    expect(validateOnchainBinding(artifact, null)).toMatchObject({
      binding: "UNVERIFIED",
      reason: "NO_CONFIRMED_IDENTITY",
    });
  });

  it("incomplete provenance cannot establish anything", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const stripped = brandOnchainArtifact({
      ...artifact,
      provenance: { ...artifact.provenance, providerId: "" },
    });
    expect(validateOnchainBinding(stripped, identity)).toMatchObject({
      binding: "UNVERIFIED",
      reason: "PROVENANCE_INCOMPLETE",
    });
  });

  it("a response whose subject disagrees with the intent cannot bind", async () => {
    // Provider answers about a DIFFERENT account than the one requested.
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const swapped = brandOnchainArtifact({
      ...artifact,
      result: { ...artifact.result, mint: OTHER_MINT } as typeof artifact.result,
    });
    expect(validateOnchainBinding(swapped, identity)).toMatchObject({
      binding: "UNVERIFIED",
      reason: "RESPONSE_SUBJECT_MISMATCH",
    });
  });

  it("a derived-account artifact preserves BOTH the project anchor and the subject", async () => {
    const payload = { context: { slot: 7 }, value: { amount: "50", decimals: 2 } };
    const artifact = await adapterWith(payload).retrieve({
      kind: "TOKEN_ACCOUNT_BALANCE",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "account",
      subject: ACCOUNT,
    });
    expect(artifact.provenance.projectAnchor).toBe(MINT);
    expect(artifact.provenance.subject).toBe(ACCOUNT);
    expect(artifact.provenance.projectAnchor).not.toBe(artifact.provenance.subject);
    const parsed = parseCanonicalOnchainUri(artifact.canonicalUri)!;
    expect(parsed.projectAnchor).toBe(MINT);
    expect(parsed.subject).toBe(ACCOUNT);
    expect(validateOnchainBinding(artifact, identity).binding).toBe("CONFIRMED");
  });
});

describe("source class safety — a URI can never manufacture ONCHAIN_VERIFIABLE", () => {
  it("a canonical URI string alone is not classified ONCHAIN_VERIFIABLE by the generic path", () => {
    const uri = buildCanonicalOnchainUri(supplyIntent());
    // The generic classifier must not promote it — a fetched document can
    // never gain this class by carrying a look-alike URL.
    expect(resolveSourceClass(uri, deriveSourceType(uri), null)).not.toBe("ONCHAIN_VERIFIABLE");
  });

  it("an arbitrary fetched document cannot use the structured containment exception", () => {
    // AMENDMENT A: the exception is scoped to real artifacts only. A plain
    // object shaped like one — even carrying a perfect canonical URI and a
    // matching anchor — is refused.
    const forged = {
      canonicalUri: buildCanonicalOnchainUri(supplyIntent()),
      intent: supplyIntent(),
      result: { kind: "TOKEN_SUPPLY", mint: MINT, amountRaw: "1", decimals: 0 },
      provenance: null,
      normalizedText: "{}",
    };
    expect(evaluateStructuredContainment(forged, identity)).toMatchObject({
      contained: false,
    });
    expect(evaluateStructuredContainment("https://example.com/page", identity)).toMatchObject({
      contained: false,
      reason: "NOT_A_STRUCTURED_ARTIFACT",
    });
    expect(evaluateStructuredContainment(null, identity)).toMatchObject({ contained: false });
  });

  it("a genuine artifact with a non-matching identity is still refused containment", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    expect(
      evaluateStructuredContainment(artifact, {
        chain: "solana",
        tokenAddress: OTHER_MINT,
        ticker: "X",
      }),
    ).toMatchObject({ contained: false, reason: "BINDING_NOT_CONFIRMED" });
  });
});

describe("adapter safety", () => {
  it("only the five approved RPC methods exist, and no pass-through", () => {
    expect([...SOLANA_ALLOWED_RPC_METHODS].sort()).toEqual(
      [
        "getAccountInfo",
        "getSignaturesForAddress",
        "getTokenAccountBalance",
        "getTokenSupply",
        "getTransaction",
      ].sort(),
    );
    // No API on the adapter accepts a method name.
    const adapter = adapterWith(SUPPLY_PAYLOAD);
    expect(Object.keys(adapter).sort()).toEqual(["name", "retrieve", "supports"]);
  });

  it("a malformed RPC response is rejected, never normalized into a fact", async () => {
    await expect(
      adapterWith({ context: {}, value: { amount: "not-a-number" } }).retrieve(supplyIntent()),
    ).rejects.toThrow(OnchainRetrieverUnavailableError);
    await expect(
      createSolanaOnchainAdapter({
        transport: { async call() { return "<html>not json</html>"; } },
        providerId: "fixture-rpc",
        finality: "finalized",
      }).retrieve(supplyIntent()),
    ).rejects.toThrow(OnchainRetrieverUnavailableError);
  });

  it("a JSON-RPC error envelope is a provider failure, never a fact", async () => {
    const adapter = createSolanaOnchainAdapter({
      transport: {
        async call() {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "Invalid param" },
          });
        },
      },
      providerId: "fixture-rpc",
      finality: "finalized",
    });
    await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(OnchainRetrieverUnavailableError);
  });

  it("a response that is not a JSON-RPC envelope is rejected", async () => {
    const adapter = createSolanaOnchainAdapter({
      transport: { async call() { return JSON.stringify({ context: { slot: 1 } }); } },
      providerId: "fixture-rpc",
      finality: "finalized",
    });
    await expect(adapter.retrieve(supplyIntent())).rejects.toThrow(OnchainRetrieverUnavailableError);
  });

  it("a malformed address never reaches the transport", async () => {
    let called = false;
    const adapter = createSolanaOnchainAdapter({
      transport: { async call() { called = true; return "{}"; } },
      providerId: "fixture-rpc",
      finality: "finalized",
    });
    await expect(
      adapter.retrieve(supplyIntent({ projectAnchor: "not-base58!", subject: "not-base58!" })),
    ).rejects.toThrow(OnchainRetrieverUnavailableError);
    expect(called).toBe(false);
  });

  it("endpoints come only from a code-owned allowlist of env var names", () => {
    expect(endpointEnvVarFor("solana", "mainnet")).toBe("SOLANA_MAINNET_RPC_URL");
    // No test network is addressable at all.
    expect(endpointEnvVarFor("solana", "devnet")).toBeNull();
    expect(endpointEnvVarFor("ethereum", "mainnet")).toBeNull();
    // Credential-bearing or non-https endpoints are refused.
    expect(isAcceptableEndpoint("https://rpc.example.test")).toBe(true);
    expect(isAcceptableEndpoint("http://rpc.example.test")).toBe(false);
    expect(isAcceptableEndpoint("https://user:key@rpc.example.test")).toBe(false);
  });

  it("an unconfigured environment throws rather than silently faking", () => {
    expect(() => resolveOnchainRetriever()).toThrow(OnchainRetrieverUnavailableError);
  });

  it("signature pagination is bounded", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      signature: `${SIGNATURE.slice(0, 60)}${String(i).padStart(4, "0")}`,
      slot: 500 + i,
      blockTime: null,
      err: null,
    }));
    const artifact = await adapterWith(many).retrieve({
      kind: "SIGNATURES_FOR_ADDRESS",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "account",
      subject: ACCOUNT,
      limit: 10_000,
    });
    const r = artifact.result as { kind: "SIGNATURES_FOR_ADDRESS"; signatures: unknown[] };
    expect(r.signatures.length).toBe(MAX_SIGNATURES_PER_INTENT);
  });

  it("credentials never appear in the URI, provenance or request params", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const serialized = JSON.stringify({
      uri: artifact.canonicalUri,
      provenance: artifact.provenance,
    });
    for (const forbidden = ["http://", "https://", "api_key", "apikey", "secret", "token="] as const;;) {
      for (const f of forbidden) expect(serialized.toLowerCase()).not.toContain(f);
      break;
    }
    expect(artifact.provenance.providerId).toBe("fixture-rpc"); // a label, not a URL
  });
});

describe("SPL burn decoding", () => {
  function txPayload(instructions: unknown[]) {
    return {
      slot: 900,
      blockTime: 1_700_000_000,
      transaction: { signatures: [SIGNATURE], message: { instructions } },
      meta: { err: null },
    };
  }
  const burnIntent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: MINT,
    subjectKind: "tx",
    subject: SIGNATURE,
  };

  it("a genuine SPL Burn instruction produces a burn fact", async () => {
    const artifact = await adapterWith(
      txPayload([
        {
          programId: SPL_TOKEN,
          parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "500" } },
        },
      ]),
    ).retrieve(burnIntent);
    const r = artifact.result as { kind: "TRANSACTION_DETAIL"; burns: unknown[] };
    expect(r.burns.length).toBe(1);

    const facts = synthesizeOnchainFacts(artifact, { step: 7, component: "NET_EFFECT" });
    expect(facts.length).toBe(1);
    expect(facts[0].statement).toContain("Burn");
    expect(facts[0].mechanismState).toBe("LIVE");
    expect(facts[0].doesNotProve).toBe(ONCHAIN_DOES_NOT_PROVE.BURN);
  });

  it("BurnChecked is recognised and carries decimals", async () => {
    const artifact = await adapterWith(
      txPayload([
        {
          programId: SPL_TOKEN,
          parsed: {
            type: "burnChecked",
            info: { mint: MINT, account: ACCOUNT, tokenAmount: { amount: "250", decimals: 2 } },
          },
        },
      ]),
    ).retrieve(burnIntent);
    const r = artifact.result as {
      kind: "TRANSACTION_DETAIL";
      burns: { instructionType: string; decimals: number | null }[];
    };
    expect(r.burns[0].instructionType).toBe("BurnChecked");
    expect(r.burns[0].decimals).toBe(2);
  });

  it("an ordinary transfer to a burn-LOOKING address does NOT create a burn fact", async () => {
    const artifact = await adapterWith(
      txPayload([
        {
          programId: SPL_TOKEN,
          parsed: {
            type: "transfer",
            // An address a human might call "the burn address". Chain
            // semantics say transfer; we must not reinterpret it.
            info: { mint: MINT, source: ACCOUNT, destination: "1nc1nerator11111111111111111111111111111111", amount: "500" },
          },
        },
      ]),
    ).retrieve(burnIntent);
    const r = artifact.result as { kind: "TRANSACTION_DETAIL"; burns: unknown[] };
    expect(r.burns).toEqual([]);
    expect(synthesizeOnchainFacts(artifact, { step: 7, component: "NET_EFFECT" })).toEqual([]);
  });

  it("a burn instruction from a non-SPL program is not a burn", async () => {
    const artifact = await adapterWith(
      txPayload([
        {
          programId: "NotTheTokenProgram1111111111111111111111111",
          parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "500" } },
        },
      ]),
    ).retrieve(burnIntent);
    expect((artifact.result as { burns: unknown[] }).burns).toEqual([]);
  });

  it("a burn fact never becomes a buyback fact", async () => {
    const artifact = await adapterWith(
      txPayload([
        {
          programId: SPL_TOKEN,
          parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "500" } },
        },
      ]),
    ).retrieve(burnIntent);
    const [fact] = synthesizeOnchainFacts(artifact, { step: 7, component: "NET_EFFECT" });
    const text = `${fact.statement} ${fact.doesNotProve}`.toLowerCase();
    expect(fact.statement.toLowerCase()).not.toContain("buyback");
    expect(text).toContain("does not prove the burned tokens came from a buyback");
    expect(text).toContain("separate admitted evidence");
  });

  it("a failed transaction executed nothing", async () => {
    const artifact = await adapterWith({
      ...txPayload([
        {
          programId: SPL_TOKEN,
          parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "500" } },
        },
      ]),
      meta: { err: { InstructionError: [0, "Custom"] } },
    }).retrieve(burnIntent);
    expect(synthesizeOnchainFacts(artifact, { step: 7, component: "NET_EFFECT" })).toEqual([]);
  });
});

describe("deterministic fact synthesis", () => {
  it("is byte-stable for a fixed response", async () => {
    const a1 = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    const a2 = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    expect(a1.normalizedText).toBe(a2.normalizedText);
    expect(a1.provenance.artifactHash).toBe(a2.provenance.artifactHash);
    const f1 = synthesizeOnchainFacts(a1, { step: 5, component: "CURRENT_STATE" });
    const f2 = synthesizeOnchainFacts(a2, { step: 5, component: "CURRENT_STATE" });
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));
  });

  it("an empty response creates no fact", async () => {
    const noAccount = await adapterWith({ context: { slot: 3 }, value: null }).retrieve({
      kind: "ACCOUNT_INFO",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "account",
      subject: ACCOUNT,
    });
    expect(synthesizeOnchainFacts(noAccount, { step: 6, component: "DESTINATION" })).toEqual([]);

    const noSigs = await adapterWith([]).retrieve({
      kind: "SIGNATURES_FOR_ADDRESS",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "account",
      subject: ACCOUNT,
    });
    expect(synthesizeOnchainFacts(noSigs, { step: 4, component: "EXECUTION_EVIDENCE" })).toEqual([]);
  });

  it("large amounts are formatted without floating point loss", async () => {
    const huge = { context: { slot: 1 }, value: { amount: "123456789012345678901", decimals: 9 } };
    const artifact = await adapterWith(huge).retrieve(supplyIntent());
    const [fact] = synthesizeOnchainFacts(artifact, { step: 5, component: "CURRENT_STATE" });
    expect(fact.statement).toContain("123456789012.345678901");
    expect(fact.statement).not.toContain("e+");
  });

  it("every fact carries a human-authored doesNotProve", async () => {
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    for (const f of synthesizeOnchainFacts(artifact, { step: 5, component: "CURRENT_STATE" })) {
      expect(f.doesNotProve.length).toBeGreaterThan(60);
    }
  });
});

describe("intent selection and mechanism locators (AMENDMENT D)", () => {
  it("a component the Pattern does not allow ONCHAIN_VERIFIABLE for gets no intents", () => {
    expect(
      selectOnchainIntents({
        component: "GOVERNANCE_BASIS",
        establishingClasses: ["GOVERNANCE"],
        identity,
        maxIntents: 2,
      }),
    ).toEqual([]);
  });

  it("without a mechanism locator, only the project's own token is addressed", () => {
    const intents = selectOnchainIntents({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity,
      locators: [],
      maxIntents: 2,
    });
    // SIGNATURES_FOR_ADDRESS needs an account subject; with no admitted
    // locator there is none, so mechanism execution stays unresearched
    // rather than guessing an address.
    expect(intents).toEqual([]);
  });

  it("an admitted locator unlocks account-level intents, anchor still preserved", () => {
    const intents = selectOnchainIntents({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity,
      locators: [{ address: ACCOUNT, origin: "ADMITTED_EVIDENCE_SOURCE" }],
      maxIntents: 2,
    });
    expect(intents.length).toBe(1);
    expect(intents[0].subject).toBe(ACCOUNT);
    expect(intents[0].projectAnchor).toBe(MINT);
  });

  it("no confirmed identity means no structured retrieval at all", () => {
    expect(
      selectOnchainIntents({
        component: "NET_EFFECT",
        establishingClasses: ["ONCHAIN_VERIFIABLE"],
        identity: null,
        maxIntents: 2,
      }),
    ).toEqual([]);
  });

  it("a non-Solana identity selects nothing in v1", () => {
    expect(
      selectOnchainIntents({
        component: "NET_EFFECT",
        establishingClasses: ["ONCHAIN_VERIFIABLE"],
        identity: { chain: "ethereum", tokenAddress: "0x1", ticker: "X" } as ConfirmedProjectIdentity,
        maxIntents: 2,
      }),
    ).toEqual([]);
  });
});

describe("persistence — one artifact, many facts", () => {
  it("a transaction with two burns stores ONE artifact backing TWO facts", async () => {
    const jobId = await makeJob();
    const artifact = await adapterWith({
      slot: 900,
      blockTime: 1_700_000_000,
      transaction: {
        signatures: [SIGNATURE],
        message: {
          instructions: [
            {
              programId: SPL_TOKEN,
              parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "100" } },
            },
            {
              programId: SPL_TOKEN,
              parsed: { type: "burn", info: { mint: MINT, account: ACCOUNT, amount: "200" } },
            },
          ],
        },
      },
      meta: { err: null },
    }).retrieve({
      kind: "TRANSACTION_DETAIL",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "tx",
      subject: SIGNATURE,
    });

    const result = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId,
      artifact,
      identity,
      target: { step: 7, component: "NET_EFFECT" },
    });
    expect(result.evidenceIds.length).toBe(2);

    const artifactRows = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.researchJobId, jobId));
    expect(artifactRows.length).toBe(1); // stored ONCE
    expect(artifactRows[0].projectAnchor).toBe(MINT);
    expect(artifactRows[0].subject).toBe(SIGNATURE);
    expect(artifactRows[0].slot).toBe(900);
    expect(artifactRows[0].providerId).toBe("fixture-rpc");

    const evidenceRows = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.researchJobId, jobId));
    expect(evidenceRows.length).toBe(2);
    for (const row of evidenceRows) {
      expect(row.onchainArtifactId).toBe(artifactRows[0].id); // both reference it
      expect(row.sourceClass).toBe("ONCHAIN_VERIFIABLE");
      expect(row.entityBinding).toBe("CONFIRMED");
    }
    // One shared canonical-URI source row, not one per fact.
    const srcRows = await ctx.db
      .select()
      .from(sources)
      .where(eq(sources.id, artifactRows[0].sourceId));
    expect(srcRows.length).toBe(1);
  });

  it("an artifact that fails containment persists NOTHING", async () => {
    const jobId = await makeJob();
    const artifact = await adapterWith(SUPPLY_PAYLOAD).retrieve(
      supplyIntent({ projectAnchor: OTHER_MINT, subject: OTHER_MINT }),
    );
    const result = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId,
      artifact,
      identity,
      target: { step: 7, component: "NET_EFFECT" },
    });
    expect(result.rejectedReason).toBe("BINDING_NOT_CONFIRMED");
    expect(result.evidenceIds).toEqual([]);
    expect(
      await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId)),
    ).toEqual([]);
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toEqual([]);
  });

  it("replaying the identical observation is a no-op, not a duplicate", async () => {
    const jobId = await makeJob();
    const build = () => adapterWith(SUPPLY_PAYLOAD).retrieve(supplyIntent());
    await persistOnchainArtifactAndFacts({
      db: ctx.db, jobId, artifact: await build(), identity,
      target: { step: 5, component: "CURRENT_STATE" },
    });
    await persistOnchainArtifactAndFacts({
      db: ctx.db, jobId, artifact: await build(), identity,
      target: { step: 5, component: "CURRENT_STATE" },
    });
    expect(
      (await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, jobId)))
        .length,
    ).toBe(1);
    expect(
      (await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).length,
    ).toBe(1);
  });
});

describe("budget — one bounded operation, one reservation", () => {
  it("each RPC operation reserves exactly one sourceOpen before it runs", async () => {
    const jobId = await makeJob();
    const order: string[] = [];
    const outcome = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 5, component: "CURRENT_STATE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      maxSourceOpens: 24,
      retriever: {
        name: "fixture",
        supports: () => true,
        retrieve: async (i) => {
          order.push("call");
          return adapterWith(SUPPLY_PAYLOAD).retrieve(i);
        },
      },
      reserve: async () => {
        order.push("reserve");
        return true;
      },
    });
    expect(outcome.sourceOpensSpent).toBe(1);
    expect(outcome.evidenceIds.length).toBe(1);
    // Reservation strictly precedes the call, every time.
    expect(order).toEqual(["reserve", "call"]);
  });

  it("a refused reservation stops the loop and performs no call", async () => {
    const jobId = await makeJob();
    let called = false;
    const outcome = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 5, component: "CURRENT_STATE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      maxSourceOpens: 24,
      retriever: {
        name: "fixture",
        supports: () => true,
        retrieve: async (i) => { called = true; return adapterWith(SUPPLY_PAYLOAD).retrieve(i); },
      },
      reserve: async () => false,
    });
    expect(called).toBe(false);
    expect(outcome.sourceOpensSpent).toBe(0);
    expect(outcome.evidenceIds).toEqual([]);
    expect(outcome.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
  });

  it("intents per attempt are bounded", () => {
    expect(MAX_ONCHAIN_INTENTS_PER_ATTEMPT).toBeLessThanOrEqual(2);
    const intents = selectOnchainIntents({
      component: "DESTINATION",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      identity,
      locators: Array.from({ length: 50 }, (_, i) => ({
        address: `Acct${String(i).padStart(38, "x")}`,
        origin: "ADMITTED_EVIDENCE_SOURCE" as const,
      })),
      maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
    });
    expect(intents.length).toBeLessThanOrEqual(MAX_ONCHAIN_INTENTS_PER_ATTEMPT);
  });

  it("an unconfigured retriever degrades silently instead of failing the attempt", async () => {
    const jobId = await makeJob();
    const outcome = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 5, component: "CURRENT_STATE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      maxSourceOpens: 24,
    });
    expect(outcome.evidenceIds).toEqual([]);
    expect(outcome.sourceOpensSpent).toBe(0);
    expect(outcome.observations).toContain("ONCHAIN_RETRIEVER_NOT_CONFIGURED");
  });

  it("a provider failure is fail-closed: no facts, no crash", async () => {
    const jobId = await makeJob();
    const outcome = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 5, component: "CURRENT_STATE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      maxSourceOpens: 24,
      retriever: {
        name: "fixture",
        supports: () => true,
        retrieve: async () => { throw new OnchainRetrieverUnavailableError("rpc down"); },
      },
      reserve: async () => true,
    });
    expect(outcome.evidenceIds).toEqual([]);
    expect(outcome.observations).toContain("ONCHAIN_RETRIEVAL_FAILED");
  });
});

describe("production transport — configuration and secret containment", () => {
  const ENV = "SOLANA_MAINNET_RPC_URL";
  const original = process.env[ENV];
  afterAll(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("an unlisted (chain, network) is unreachable no matter what is configured", () => {
    process.env[ENV] = "https://rpc.example.test";
    expect(createProductionOnchainRetriever("solana", "devnet")).toBeNull();
    expect(createProductionOnchainRetriever("ethereum", "mainnet")).toBeNull();
  });

  it("an unset or unacceptable endpoint yields no retriever, never a partial one", () => {
    delete process.env[ENV];
    expect(createProductionOnchainRetriever("solana", "mainnet")).toBeNull();
    process.env[ENV] = "http://rpc.example.test"; // not https
    expect(createProductionOnchainRetriever("solana", "mainnet")).toBeNull();
    process.env[ENV] = "https://user:secret@rpc.example.test"; // credential in userinfo
    expect(createProductionOnchainRetriever("solana", "mainnet")).toBeNull();
  });

  it("a configured endpoint yields a retriever whose provider label leaks no part of the URL", () => {
    // A key embedded in the path is the common provider shape, so the URL
    // itself must be treated as a credential.
    process.env[ENV] = "https://rpc.example.test/SUPER_SECRET_KEY_VALUE";
    const retriever = createProductionOnchainRetriever("solana", "mainnet");
    expect(retriever).not.toBeNull();
    expect(retriever!.name).toBe("solana-rpc:solana-mainnet-rpc");
    const serialized = JSON.stringify({ name: retriever!.name });
    expect(serialized).not.toContain("SUPER_SECRET_KEY_VALUE");
    expect(serialized).not.toContain("rpc.example.test");
  });

  it("transport errors never carry the endpoint or the response body", () => {
    const err = new OnchainTransportError("HTTP_ERROR", "solana-mainnet-rpc");
    expect(err.message).toContain("solana-mainnet-rpc");
    expect(err.message).not.toContain("http");
    expect(err.message).not.toContain("SECRET");
  });

  it("the transport interface exposes no way to supply a URL", () => {
    const transport = createHttpsRpcTransport(
      "https://rpc.example.test",
      "label",
      { timeoutMs: 1 },
    );
    // call(method, params) only — there is no endpoint parameter.
    expect(transport.call.length).toBe(2);
    expect(Object.keys(transport)).toEqual(["call"]);
  });
});

describe("generalization", () => {
  it("no project-specific literal appears in the generic on-chain modules", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/onchain-acquisition.ts",
      "../src/server/engine/onchain-binding.ts",
      "../src/server/engine/onchain-facts.ts",
      "../src/server/engine/onchain-uri.ts",
      "../src/server/engine/providers/onchain-types.ts",
      "../src/server/engine/providers/onchain-retriever.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      // Project-identifying literals are banned outright. "buyback" is
      // deliberately NOT in this list: it appears once, inside the
      // owner-mandated doesNotProve prose that must state a burn does not
      // prove the tokens came from a buyback. That is generic economic
      // vocabulary in methodology text, not project-specific logic — and
      // removing it would delete a required disclaimer.
      for (const banned of ["pump", "etherscan", "solscan"]) {
        expect(code, `${path} contains "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("no on-chain module hard-codes any address, mint or program except SPL infrastructure", async () => {
    const fs = await import("node:fs/promises");
    // A base58 run of 32+ chars in code (not comments) would be a
    // hard-coded address — exactly the project-specific coupling the
    // architecture forbids.
    const addressLike = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
    for (const path of [
      "../src/server/engine/onchain-acquisition.ts",
      "../src/server/engine/onchain-binding.ts",
      "../src/server/engine/onchain-facts.ts",
      "../src/server/engine/onchain-uri.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      expect(addressLike.test(code), `${path} hard-codes an address`).toBe(false);
    }
  });

  it("the only addresses in the Solana adapter are the two SPL Token program ids", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/onchain-solana.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const found = code.match(/["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/g) ?? [];
    const cleaned = found.map((f) => f.slice(1, -1)).sort();
    expect(cleaned).toEqual(
      [
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      ].sort(),
    );
  });

  it("the Solana adapter hard-codes only chain infrastructure, never a project", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/onchain-solana.ts", import.meta.url),
      "utf-8",
    );
    expect(raw.toLowerCase()).not.toContain("pump");
    expect(raw.toLowerCase()).not.toContain("buyback");
  });
});
