import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { evidence, projects, sources, topics, users } from "../src/server/db/schema";
import {
  KNOWN_NON_TRANSACTION_BYTES32,
  validateDocumentaryLocator,
} from "../src/server/engine/documentary-locator";
import {
  admittedLocatorsForJob,
  MAX_ADMITTED_LOCATORS_PER_JOB,
  persistFactLocators,
  validateFactLocators,
  type ConfirmedLocator,
} from "../src/server/engine/documentary-locator-store";
import { renderLinkAppendix, extractDocumentLinks } from "../src/server/engine/providers/document-links";
import { createEvmOnchainAdapter } from "../src/server/engine/providers/onchain-evm";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EVM TRANSACTION-HASH ADMISSION RELIABILITY (Founder-approved).
//
// A 0x+64-hex value is refused as a transaction locator ONLY when every
// known occurrence of it is deterministic non-transaction structure (a
// /proposal/ path, a Safe multisig identifier or /multisig-transactions/
// path, or an exact known constant). Everything else — bare prose, other
// URLs, transaction paths — stays admissible, and a value presented in an
// explicit /tx/ path is admitted FIRST so it cannot be crowded out.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const H = (seed: string) => "0x" + seed.repeat(64).slice(0, 64);
const HASH = H("a1b2");
const SAFE = "0x" + "5afe".repeat(10);

const validate = (documentText: string, value = HASH, links?: { href: string; text: string }[]) =>
  validateDocumentaryLocator({ claimedLocator: value, documentText, chain: "ethereum", links: links ?? null });

// ---------------------------------------------------------------------------
// Keccak-256, test-local, so every constant in the code-owned list is
// re-derived from its published preimage rather than trusted.
// ---------------------------------------------------------------------------
function keccak256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const RC = [
    BigInt("0x0000000000000001"), BigInt("0x0000000000008082"), BigInt("0x800000000000808a"), BigInt("0x8000000080008000"),
    BigInt("0x000000000000808b"), BigInt("0x0000000080000001"), BigInt("0x8000000080008081"), BigInt("0x8000000000008009"),
    BigInt("0x000000000000008a"), BigInt("0x0000000000000088"), BigInt("0x0000000080008009"), BigInt("0x000000008000000a"),
    BigInt("0x000000008000808b"), BigInt("0x800000000000008b"), BigInt("0x8000000000008089"), BigInt("0x8000000000008003"),
    BigInt("0x8000000000008002"), BigInt("0x8000000000000080"), BigInt("0x000000000000800a"), BigInt("0x800000008000000a"),
    BigInt("0x8000000080008081"), BigInt("0x8000000000008080"), BigInt("0x0000000080000001"), BigInt("0x8000000080008008"),
  ];
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const MASK = (BigInt(1) << BigInt(64)) - BigInt(1);
  const rot = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s: bigint[] = new Array(25).fill(BigInt(0));
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = BigInt(0);
      for (let b = 7; b >= 0; b--) v = (v << BigInt(8)) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= v;
    }
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= D;
      }
      const B: bigint[] = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(s[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK & B[((x + 2) % 5) + 5 * y]);
      s[0] ^= RC[r];
    }
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    let v = s[i];
    for (let b = 0; b < 8; b++) {
      out += Number(v & BigInt("0xff")).toString(16).padStart(2, "0");
      v >>= BigInt(8);
    }
  }
  return `0x${out}`;
}
const minusOne = (h: string) => "0x" + (BigInt(h) - BigInt(1)).toString(16).padStart(64, "0");

describe("the code-owned constant list is exactly what its labels say", () => {
  it("keccak is the Ethereum one (empty-input vector)", () => {
    expect(keccak256("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("every entry re-derives from its published preimage", () => {
    const derived: Record<string, string> = {
      "all-zero bytes32": "0x" + "0".repeat(64),
      "EIP-1967 implementation slot": minusOne(keccak256("eip1967.proxy.implementation")),
      "EIP-1967 admin slot": minusOne(keccak256("eip1967.proxy.admin")),
      "EIP-1967 beacon slot": minusOne(keccak256("eip1967.proxy.beacon")),
    };
    for (const [value, label] of KNOWN_NON_TRANSACTION_BYTES32) {
      const expected = derived[label] ?? keccak256(label);
      expect(value, label).toBe(expected);
    }
    expect(KNOWN_NON_TRANSACTION_BYTES32.size).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Validation 1–5, 12: what is refused, and only that
// ---------------------------------------------------------------------------

describe("refused: every occurrence is deterministic non-transaction structure", () => {
  it("1. a Snapshot proposal ID (snapshot.org and snapshot.box forms)", () => {
    for (const doc of [
      `Vote in [MIP-75](https://snapshot.org/#/morpho.eth/proposal/${HASH}).`,
      `See https://snapshot.box/#/s:gnosis.eth/proposal/${HASH} for GIP-116.`,
    ]) {
      expect(validate(doc)).toEqual({ locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" });
    }
  });

  it("2. a Safe app internal multisig identifier", () => {
    const doc = `Queued: https://app.safe.global/transactions/tx?safe=eth:${SAFE}&id=multisig_${SAFE}_${HASH}`;
    expect(validate(doc)).toEqual({ locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" });
  });

  it("3. a Safe transaction-service /multisig-transactions/ path", () => {
    const doc = `API: https://safe-transaction-mainnet.safe.global/api/v1/multisig-transactions/${HASH}/`;
    expect(validate(doc)).toEqual({ locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" });
  });

  it("4. the all-zero bytes32, even as bare prose", () => {
    const zero = "0x" + "0".repeat(64);
    expect(validate(`DEFAULT_ADMIN_ROLE is ${zero}.`, zero)).toEqual({
      locator: "NONE",
      reason: "NOT_A_TRANSACTION_REFERENCE",
    });
  });

  it("5. an exact known event signature or protocol constant, even as bare prose, in any case", () => {
    for (const [value] of KNOWN_NON_TRANSACTION_BYTES32) {
      expect(validate(`topic ${value} here`, value).locator, value).toBe("NONE");
    }
    const upper = "0x" + "DDF252AD1BE2C89B69C2B068FC378DAA952BA7F163C4A11628F55A4DF523B3EF";
    expect(validate(`Transfer topic ${upper}`, upper)).toEqual({ locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" });
  });

  it("a hash that is only a non-transaction LINK's anchor text is refused through the structured links", () => {
    // Static fetch: the href is gone from the text, the anchor text remains.
    const links = [{ href: `https://snapshot.org/#/lido-snapshot.eth/proposal/${HASH}`, text: HASH }];
    expect(validate(`Proposal ${HASH} passed.`, HASH, links)).toEqual({
      locator: "NONE",
      reason: "NOT_A_TRANSACTION_REFERENCE",
    });
    // Rendered fetch: the appendix line this codebase writes carries the
    // href and the anchor text; both resolve to the proposal structure.
    const html = `<p>Proposal <a href="https://snapshot.org/#/lido-snapshot.eth/proposal/${HASH}">${HASH}</a> passed.</p>`;
    const parsed = extractDocumentLinks(html);
    const rendered = `Proposal ${HASH} passed.\n\n${renderLinkAppendix(parsed)}`;
    expect(validate(rendered, HASH, parsed.links)).toEqual({ locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" });
  });
});

describe("kept: any occurrence outside excluded structure keeps the value admissible", () => {
  it("6. proposal URL AND bare prose → kept, not transaction-structured", () => {
    const doc = `Proposal https://snapshot.org/#/x.eth/proposal/${HASH}. Executed in ${HASH}.`;
    expect(validate(doc)).toEqual({ locator: "CONFIRMED", value: HASH, shape: "SIGNATURE_LIKE", transactionStructured: false });
  });

  it("7. proposal URL AND /tx/ link → kept AND transaction-structured", () => {
    const doc = `Proposal https://snapshot.org/#/x.eth/proposal/${HASH} executed: https://etherscan.io/tx/${HASH}`;
    expect(validate(doc)).toEqual({ locator: "CONFIRMED", value: HASH, shape: "SIGNATURE_LIKE", transactionStructured: true });
    // The same through structured links only: anchor text in the body, the
    // /tx/ href known from the link list.
    const links = [{ href: `https://etherscan.io/tx/${HASH}`, text: HASH }];
    expect(validate(`Burn transaction ${HASH}.`, HASH, links)).toMatchObject({
      locator: "CONFIRMED",
      transactionStructured: true,
    });
  });

  it("8. a bare 0x+64-hex value in official prose is still admitted", () => {
    expect(validate(`The burn was executed in transaction ${HASH} on Ethereum.`)).toEqual({
      locator: "CONFIRMED",
      value: HASH,
      shape: "SIGNATURE_LIKE",
      transactionStructured: false,
    });
  });

  it("an explorer link is NOT required: a /transaction/ path counts, an unrecognised URL keeps the value", () => {
    expect(validate(`https://blockchair.com/ethereum/transaction/${HASH}`)).toMatchObject({ transactionStructured: true });
    expect(validate(`https://example.org/receipts/${HASH}`)).toMatchObject({
      locator: "CONFIRMED",
      transactionStructured: false,
    });
  });

  it("no nearby word decides anything: 'proposal' in prose does not refuse, 'transaction' in prose does not prioritise", () => {
    expect(validate(`Snapshot proposal id: ${HASH}`)).toMatchObject({ locator: "CONFIRMED", transactionStructured: false });
    expect(validate(`tx hash ${HASH}`)).toMatchObject({ locator: "CONFIRMED", transactionStructured: false });
  });

  it("a bare occurrence is explained away only when every same-text link is excluded structure and they cover it", () => {
    const proposal = { href: `https://snapshot.org/#/x.eth/proposal/${HASH}`, text: HASH };
    // Two bare occurrences, one proposal link: the second could be prose.
    expect(validate(`${HASH} and again ${HASH}`, HASH, [proposal]).locator).toBe("CONFIRMED");
    // A same-text link that is not excluded structure: doubt keeps it.
    const other = { href: `https://example.org/${HASH}`, text: HASH };
    expect(validate(`${HASH}`, HASH, [proposal, other]).locator).toBe("CONFIRMED");
  });

  it("12. an arbitrary bytes32 the rule does not recognise stays admissible and still fails closed at the receipt read", async () => {
    const blockHash = H("b10c");
    expect(validate(`Block hash ${blockHash}`, blockHash).locator).toBe("CONFIRMED");
    const calls: string[] = [];
    const adapter = createEvmOnchainAdapter({
      transport: {
        async call(method) {
          calls.push(method);
          if (method === "eth_chainId") return JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });
          return JSON.stringify({ jsonrpc: "2.0", id: 1, result: null });
        },
      },
      providerId: "fixture",
      environment: { chain: "ethereum", network: "mainnet" },
    });
    await expect(
      adapter.retrieve({
        kind: "TRANSACTION_DETAIL",
        chain: "ethereum",
        network: "mainnet",
        projectAnchor: "0x" + "ab".repeat(20),
        subjectKind: "tx",
        subject: blockHash,
      }),
    ).rejects.toThrow(/receipt is not available/);
    expect(calls).toEqual(["eth_chainId", "eth_getTransactionReceipt"]);
  });
});

// ---------------------------------------------------------------------------
// Validation 10: Solana and addresses are untouched
// ---------------------------------------------------------------------------

describe("10. Solana locators and EVM addresses are unchanged", () => {
  it("a base58 signature after /proposal/ is confirmed exactly as before (the rule is EVM-only)", () => {
    const sig = "5".repeat(88);
    expect(
      validateDocumentaryLocator({ claimedLocator: sig, documentText: `https://x.org/proposal/${sig}`, chain: "solana" }),
    ).toEqual({ locator: "CONFIRMED", value: sig, shape: "SIGNATURE_LIKE" });
  });

  it("a Solana address and an EVM address carry no new field", () => {
    const address = "Locator11111111111111111111111111111111111";
    expect(validateDocumentaryLocator({ claimedLocator: address, documentText: `to ${address}`, chain: "solana" })).toEqual({
      locator: "CONFIRMED",
      value: address,
      shape: "ADDRESS_LIKE",
    });
    const evm = "0x" + "ab".repeat(20);
    expect(validateDocumentaryLocator({ claimedLocator: evm, documentText: `https://x.org/proposal/${evm}`, chain: "ethereum" })).toEqual({
      locator: "CONFIRMED",
      value: evm,
      shape: "ADDRESS_LIKE",
    });
  });

  it("validateFactLocators records the refusal under its own reason", () => {
    const outcome = validateFactLocators({
      claimed: [HASH],
      documentText: `https://snapshot.org/#/x.eth/proposal/${HASH}`,
      chain: "ethereum",
    });
    expect(outcome).toEqual({ confirmed: [], rejected: [{ claimed: HASH, reason: "NOT_A_TRANSACTION_REFERENCE" }] });
  });

  it("the trace reason and the ordering column exist in the schema and the forward migration", () => {
    const enums = readFileSync("src/server/db/schema/enums.ts", "utf-8");
    expect(enums).toContain('"LOCATOR_NOT_TRANSACTION_REFERENCE"');
    const migration = readFileSync("src/server/db/migrations/0058_evm_transaction_reference_locators.sql", "utf-8");
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'LOCATOR_NOT_TRANSACTION_REFERENCE'");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "transaction_structured" boolean DEFAULT false NOT NULL');
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b/i);
  });
});

// ---------------------------------------------------------------------------
// Validation 9, 11: admission ordering and unchanged authority (DB)
// ---------------------------------------------------------------------------

async function makeJob(): Promise<string> {
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("txref"), name: "Tx Reference Project", status: "ACTIVE_CORE" })
    .returning();
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "were tokens burned?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

async function factWith(jobId: string, locators: ConfirmedLocator[], officiality: "CONFIRMED" | "CLAIMED" = "CONFIRMED") {
  const [source] = await ctx.db
    .insert(sources)
    .values({ url: `https://docs.example.test/${uniq("p")}`, urlHash: uniq("uh"), sourceType: "OFFICIAL_DOCS", health: "OK" })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      sourceId: source.id,
      researchJobId: jobId,
      relationship: "SUPPORTS",
      fragment: `governance page ${uniq("f")}`,
      summary: "governance page",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: new Date(),
      evidenceContractVersion: 2,
      patternStep: 4,
      component: "EXECUTION_EVIDENCE",
      directness: "DIRECT",
      sourceClass: "GOVERNANCE",
      officiality,
    })
    .returning();
  await persistFactLocators(ctx.db, row.id, locators);
}

// Nine unstructured transaction-shaped values that sort BEFORE the real one
// under the old character order.
const CROWD = Array.from({ length: 9 }, (_, i) => "0x0" + String(i + 1).repeat(63).slice(0, 63));
const REAL = "0x" + "f".repeat(63) + "1";

describe("9. a real transaction reference cannot be crowded out", () => {
  it("before (no structure recorded): character order admits the crowd and drops the real one", async () => {
    const jobId = await makeJob();
    await factWith(jobId, [...CROWD, REAL].map((value) => ({ value, shape: "SIGNATURE_LIKE" as const })));
    const admitted = (await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value);
    expect(admitted).toHaveLength(MAX_ADMITTED_LOCATORS_PER_JOB);
    expect(admitted).not.toContain(REAL);
  }, 60_000);

  it("after: the /tx/-structured value is admitted first, under the unchanged cap", async () => {
    const jobId = await makeJob();
    await factWith(jobId, [
      ...CROWD.map((value) => ({ value, shape: "SIGNATURE_LIKE" as const, transactionStructured: false })),
      { value: REAL, shape: "SIGNATURE_LIKE", transactionStructured: true },
    ]);
    const admitted = (await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value);
    expect(admitted).toHaveLength(MAX_ADMITTED_LOCATORS_PER_JOB);
    expect(admitted[0]).toBe(REAL);
    // The rest keep the old deterministic order: bare values are not dropped
    // for lacking structure, only placed after it.
    expect(admitted.slice(1)).toEqual([...CROWD].sort().slice(0, MAX_ADMITTED_LOCATORS_PER_JOB - 1));
  }, 60_000);

  it("end to end from a page: nine proposal IDs are refused and the /tx/ reference is admitted", async () => {
    const proposals = CROWD.map((h) => `https://snapshot.org/#/x.eth/proposal/${h}`).join(" ");
    const doc = `${proposals} Executed: https://etherscan.io/tx/${REAL}`;
    const outcome = validateFactLocators({ claimed: [...CROWD, REAL], documentText: doc, chain: "ethereum" });
    expect(outcome.rejected.map((r) => r.reason)).toEqual(new Array(9).fill("NOT_A_TRANSACTION_REFERENCE"));
    expect(outcome.confirmed).toEqual([{ value: REAL, shape: "SIGNATURE_LIKE", transactionStructured: true }]);
    const jobId = await makeJob();
    await factWith(jobId, outcome.confirmed);
    expect((await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value)).toEqual([REAL]);
  }, 60_000);

  it("with no structured value present, admission order is exactly the old one", async () => {
    const jobId = await makeJob();
    const address = "0x" + "cd".repeat(20);
    await factWith(jobId, [
      { value: CROWD[3], shape: "SIGNATURE_LIKE" },
      { value: address, shape: "ADDRESS_LIKE" },
      { value: CROWD[0], shape: "SIGNATURE_LIKE", transactionStructured: false },
    ]);
    const admitted = (await admittedLocatorsForJob(ctx.db, jobId)).map((l) => l.value);
    expect(admitted).toEqual([CROWD[0], CROWD[3], address].sort((a, b) => a.localeCompare(b)));
  }, 60_000);
});

describe("11. source authority is unchanged", () => {
  it("a /tx/-structured locator on a CLAIMED source is still not admitted", async () => {
    const jobId = await makeJob();
    await factWith(jobId, [{ value: REAL, shape: "SIGNATURE_LIKE", transactionStructured: true }], "CLAIMED");
    expect(await admittedLocatorsForJob(ctx.db, jobId)).toEqual([]);
  }, 60_000);
});
