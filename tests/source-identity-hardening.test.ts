import { describe, expect, it } from "vitest";

import { reconcileComponent } from "../src/server/engine/component-reconciler";
import type {
  ComponentRequirements,
  EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import {
  computeEntityBinding,
  urlReferencesAddress,
  type ConfirmedProjectIdentity,
} from "../src/server/domain/project-identity";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";
import { afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { projectMemoryItems, projects } from "../src/server/db/schema";

// D-135 (RISK 1) — official domain != official docs.
//
// A confirmed pump.fun/docs OFFICIAL_DOCS route, stored as a bare
// { domain: "pump.fun" } SOURCE_ROUTE, made the ENTIRE pump.fun domain
// classify as OFFICIAL_DOCS — too broad. SOURCE_ROUTE now supports an
// optional pathPrefix: officiality (domain ownership) stays domain-wide,
// exactly as D-074 always intended, but routeClass only applies to pages
// whose path actually matches the confirmed prefix.
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeProject(): Promise<string> {
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("identity_proj"), name: "Identity Test Project", status: "ACTIVE_CORE" })
    .returning();
  return p.id;
}

async function confirmRoute(
  projectId: string,
  content: Record<string, unknown>,
): Promise<void> {
  const [row] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId, kind: "SOURCE_ROUTE", content })
    .returning();
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "CANDIDATE" })
    .where(eq(projectMemoryItems.id, row.id));
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "ACTIVE" })
    .where(eq(projectMemoryItems.id, row.id));
}

describe("source-authority — path-scoped SOURCE_ROUTE (D-135, RISK 1)", () => {
  it("1. a confirmed official domain alone does not make every page OFFICIAL_DOCS", async () => {
    const projectId = await makeProject();
    // A BARE domain confirmation with no routeClass at all.
    await confirmRoute(projectId, { domain: "example-project.org" });
    const result = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/blog/anything");
    expect(result.officiality).toBe("CONFIRMED");
    expect(result.routeClass).toBeNull();
  });

  it("2. a confirmed /docs path CAN establish OFFICIAL_DOCS routing", async () => {
    const projectId = await makeProject();
    await confirmRoute(projectId, {
      domain: "example-project.org",
      routeClass: "OFFICIAL_DOCS",
      pathPrefix: "/docs",
    });
    const onDocs = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/docs/whatever");
    expect(onDocs.officiality).toBe("CONFIRMED");
    expect(onDocs.routeClass).toBe("OFFICIAL_DOCS");
    const exactPrefix = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/docs");
    expect(exactPrefix.routeClass).toBe("OFFICIAL_DOCS");
  });

  it("3. official pages outside /docs keep confirmed officiality WITHOUT being promoted to documentation", async () => {
    const projectId = await makeProject();
    await confirmRoute(projectId, {
      domain: "example-project.org",
      routeClass: "OFFICIAL_DOCS",
      pathPrefix: "/docs",
    });
    // The exact live-run shape: same domain, a DIFFERENT path.
    const onBlog = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/blog/announcement");
    expect(onBlog.officiality).toBe("CONFIRMED"); // still the project's own domain
    expect(onBlog.routeClass).toBeNull(); // but NOT documentation
    const onRoot = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/");
    expect(onRoot.officiality).toBe("CONFIRMED");
    expect(onRoot.routeClass).toBeNull();
  });

  it("path prefix matching respects a segment boundary (no /doc matching /documentation)", async () => {
    const projectId = await makeProject();
    await confirmRoute(projectId, {
      domain: "example-project.org",
      routeClass: "OFFICIAL_DOCS",
      pathPrefix: "/docs",
    });
    const lookalike = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/docsomething");
    expect(lookalike.routeClass).toBeNull();
    const nested = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/docs/api/v2");
    expect(nested.routeClass).toBe("OFFICIAL_DOCS");
  });

  it("omitting pathPrefix keeps the pre-D-135 domain-wide behaviour unchanged", async () => {
    const projectId = await makeProject();
    await confirmRoute(projectId, { domain: "example-project.org", routeClass: "GOVERNANCE" });
    const anyPage = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/anywhere/at/all");
    expect(anyPage.routeClass).toBe("GOVERNANCE");
  });

  it("6. governance still requires its own confirmed project-specific route (unaffected by path scoping)", async () => {
    const projectId = await makeProject();
    const none = await resolveSourceRoute(ctx.db, projectId, "https://example-project.org/governance");
    expect(none.officiality).toBe("CLAIMED");
    expect(none.routeClass).toBeNull();
  });
});

// D-134 (RISK 2) — on-chain entity binding as an evidence-eligibility
// prerequisite.
const SOLANA_MINT = "So11111111111111111111111111111111111111112";
const OTHER_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

function onchainRequirements(): ComponentRequirements {
  return {
    component: "NET_EFFECT",
    establishingClasses: ["ONCHAIN_VERIFIABLE"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "MEDIUM_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
  };
}

function onchainRow(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: overrides.id ?? "row-1",
    researchJobId: "job-1",
    sourceId: "source-1",
    evidenceContractVersion: 2,
    patternStep: 7,
    component: "NET_EFFECT",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "the contract holds a balance",
    summary: "balance held",
    mechanismState: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    entityBinding: "UNVERIFIED",
    fetchedAt: new Date(),
    publishedAt: new Date(),
    extractionUnitKey: "unit-1",
    contentHash: "hash-1",
    ...overrides,
  };
}

const solanaIdentity: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: SOLANA_MINT,
  ticker: "EXMPL",
};

describe("entity binding — URL-to-address verification (D-134, RISK 2)", () => {
  it("4. an exact confirmed Solana mint establishes identity on a compatible explorer URL", () => {
    expect(urlReferencesAddress(`https://solscan.io/token/${SOLANA_MINT}`, "solana", SOLANA_MINT)).toBe(true);
    expect(urlReferencesAddress(`https://solana.fm/address/${SOLANA_MINT}?cluster=mainnet`, "solana", SOLANA_MINT)).toBe(true);
    expect(computeEntityBinding(`https://solscan.io/token/${SOLANA_MINT}`, "ONCHAIN_VERIFIABLE", solanaIdentity)).toBe(
      "CONFIRMED",
    );
  });

  it("5. a DIFFERENT Solana mint fails entity binding", () => {
    expect(urlReferencesAddress(`https://solscan.io/token/${OTHER_SOLANA_MINT}`, "solana", SOLANA_MINT)).toBe(false);
    expect(
      computeEntityBinding(`https://solscan.io/token/${OTHER_SOLANA_MINT}`, "ONCHAIN_VERIFIABLE", solanaIdentity),
    ).toBe("UNVERIFIED");
  });

  it("6. an Ethereum mainnet token cannot bind to a Solana-confirmed project", () => {
    // The exact live false-positive shape: an EVM address on an
    // unrelated-chain explorer, checked against a Solana identity.
    expect(urlReferencesAddress(`https://etherscan.io/token/${EVM_ADDRESS}`, "solana", SOLANA_MINT)).toBe(false);
    expect(
      computeEntityBinding(`https://etherscan.io/token/${EVM_ADDRESS}`, "ONCHAIN_VERIFIABLE", solanaIdentity),
    ).toBe("UNVERIFIED");
  });

  it("7. a testnet token cannot bind to production identity", () => {
    // sourceClass itself is already SOCIAL for a testnet host (D-131), so
    // the entity-binding axis never even applies (returns null, not
    // CONFIRMED) — the row cannot reach ONCHAIN_VERIFIABLE establishment
    // through either axis.
    expect(computeEntityBinding("https://sepolia.etherscan.io/token/0x1", "SOCIAL", solanaIdentity)).toBeNull();
  });

  it("no confirmed identity at all fails closed, never open", () => {
    expect(computeEntityBinding(`https://solscan.io/token/${SOLANA_MINT}`, "ONCHAIN_VERIFIABLE", null)).toBe(
      "UNVERIFIED",
    );
  });

  it("9. entity binding is a THIRD axis, independent of source class and officiality", () => {
    // Same URL, same class — officiality and entity binding vary
    // independently, exactly like officiality and source class already do.
    const confirmed = onchainRow({ officiality: "CLAIMED", entityBinding: "CONFIRMED" });
    const unverified = onchainRow({ officiality: "CONFIRMED", entityBinding: "UNVERIFIED" });
    expect(confirmed.sourceClass).toBe(unverified.sourceClass);
    // The class assertion (this page IS on-chain data) never changes;
    // only whether it establishes THIS project's component does.
    const established = reconcileComponent({
      jobId: "job-1",
      item: { step: 7, component: "NET_EFFECT" },
      requirements: onchainRequirements(),
      evidence: [confirmed],
      now: new Date(),
      freshnessPolicyDays: { LOW_CHANGE: 30, MEDIUM_CHANGE: 14, HIGH_CHANGE: 3 },
    });
    const notEstablished = reconcileComponent({
      jobId: "job-1",
      item: { step: 7, component: "NET_EFFECT" },
      requirements: onchainRequirements(),
      evidence: [unverified],
      now: new Date(),
      freshnessPolicyDays: { LOW_CHANGE: 30, MEDIUM_CHANGE: 14, HIGH_CHANGE: 3 },
    });
    expect(established.status).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(notEstablished.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(notEstablished.excludedEvidence[0]?.reason).toBe("ENTITY_NOT_CONFIRMED");
  });

  it("8. the historical PPF false-positive shape cannot support a pump_fun-like component after identity verification", () => {
    // Reconstructs the exact live incident: an Ethereum ERC-20 page that
    // merely matched the project's NAME, evaluated against a project
    // confirmed on Solana.
    const ppfRow = onchainRow({
      id: "ppf-row",
      fragment: "the PPF token contract includes a collectTradingFees function",
      entityBinding: computeEntityBinding(
        "https://etherscan.io/token/0xa96a70d4a5956a0529d2dd023c9f376980f77467",
        "ONCHAIN_VERIFIABLE",
        solanaIdentity,
      ),
    });
    expect(ppfRow.entityBinding).toBe("UNVERIFIED");
    const result = reconcileComponent({
      jobId: "job-1",
      item: { step: 7, component: "NET_EFFECT" },
      requirements: onchainRequirements(),
      evidence: [ppfRow],
      now: new Date(),
      freshnessPolicyDays: { LOW_CHANGE: 30, MEDIUM_CHANGE: 14, HIGH_CHANGE: 3 },
    });
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.excludedEvidence[0]?.reason).toBe("ENTITY_NOT_CONFIRMED");
  });

  it("class definition itself is unchanged: a wrong-asset page is still genuinely ONCHAIN_VERIFIABLE data", () => {
    // The task's own explicit boundary: entity binding must never
    // reclassify sourceClass. A row with UNVERIFIED binding is still
    // recorded, still readable, still literally ONCHAIN_VERIFIABLE — it
    // is only ineligible to ESTABLISH this project's component.
    const row = onchainRow({ entityBinding: "UNVERIFIED" });
    expect(row.sourceClass).toBe("ONCHAIN_VERIFIABLE");
  });

  it("10. no PUMP-specific conclusion is encoded in the identity/binding implementation", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/domain/project-identity.ts",
      "../src/server/engine/component-reconciler.ts",
      "../src/server/engine/source-authority.ts",
    ]) {
      const src = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code.toLowerCase(), path).not.toContain("pump");
      expect(code, path).not.toMatch(/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn/);
    }
  });
});
