import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, type ProductConfig } from "../src/server/config/product";
import { productConfig, projects, users } from "../src/server/db/schema";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { evaluateGates } from "../src/server/services/gates";
import type { GateView } from "../src/client/api";
import {
  canStartProof,
  proofBlockReason,
  type ProofGateSubject,
} from "../src/client/proof-gate";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// THE ASK SCREEN'S PROOF BUTTON, decided by the server and only by the
// server.
//
// The bug this file exists to prevent: the client used to require
// `gates.entitlement === "OK"` in addition to `gates.research ===
// "AVAILABLE"`. Those two fields answer different questions —
// `entitlement` is what this user's SUBSCRIPTION alone allows, computed
// deliberately without the owner-alpha override — so an eligible ADMIN
// asking about a project outside `demo_project_slugs` got
// research=AVAILABLE together with entitlement=CORE_REQUIRED, and the
// button was disabled with "this research requires ARI • CORE".
//
// Every case below drives the REAL evaluateGates and feeds its real
// output to the REAL client decision. Nothing is hand-made.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

function config(overrides: Partial<ProductConfig> = {}): ProductConfig {
  return { ...DEFAULT_PRODUCT_CONFIG, ...overrides };
}

async function makeUser(role: "USER" | "ADMIN" = "USER"): Promise<string> {
  const [u] = await ctx.db.insert(users).values({ role }).returning();
  return u.id;
}

// An owner-alpha project that is NOT reachable by a DEMO subscription —
// exactly the shape that exposed the bug. Chosen from the code-owned
// allowlist, never hardcoded here.
const ALLOWLISTED = [...INTERNAL_ALPHA_LIVE_PROJECT_SLUGS].find(
  (s) => !DEFAULT_PRODUCT_CONFIG.demo_project_slugs.includes(s),
);

async function ensureProject(slug: string) {
  const [existing] = await ctx.db.select().from(projects).where(eq(projects.slug, slug));
  if (existing) return existing;
  const [created] = await ctx.db
    .insert(projects)
    .values({ slug, name: slug, status: "ACTIVE_CORE" })
    .returning();
  return created;
}

// The exact subject the Ask screen builds: a READY DEEP_RESEARCH
// interpretation plus whatever the server returned.
function subjectFrom(gates: { research: GateView["research"] }): ProofGateSubject {
  return {
    interpretation: { status: "READY", route: "DEEP_RESEARCH" },
    gates: { research: gates.research },
  };
}

describe("Ask — Start Proof follows the server's verdict (owner-alpha regression)", () => {
  it("1. an ordinary non-entitled user asking about a non-DEMO project → disabled, and told why", async () => {
    const slug = ALLOWLISTED!;
    await ensureProject(slug);
    const userId = await makeUser("USER");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [slug] },
    );
    // The server itself refuses: no owner-alpha eligibility for a USER.
    expect(gates.research).not.toBe("AVAILABLE");
    expect(canStartProof(subjectFrom(gates))).toBe(false);
    expect(proofBlockReason(subjectFrom(gates))).not.toBeNull();
  });

  it("a DEMO user keeps needing CORE for a project outside demo_project_slugs", async () => {
    const slug = ALLOWLISTED!;
    await ensureProject(slug);
    const userId = await makeUser("USER");
    const gates = await evaluateGates(
      ctx.db,
      // research_enabled=true makes this the ordinary public path, where
      // entitlement is the real and only reason to refuse.
      config({ research_enabled: true, internal_alpha_enabled: false }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [slug] },
    );
    expect(gates.entitlement).toBe("CORE_REQUIRED");
    expect(gates.research).toBe("CORE_REQUIRED");
    expect(canStartProof(subjectFrom(gates))).toBe(false);
    expect(proofBlockReason(subjectFrom(gates))).toBe("CORE_REQUIRED");
  });

  it("2. an eligible ADMIN owner-alpha → ENABLED, even though entitlement alone says CORE_REQUIRED", async () => {
    const slug = ALLOWLISTED!;
    await ensureProject(slug);
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [slug] },
    );

    // THE REGRESSION, in two lines: the server grants research, and the
    // raw entitlement axis still says CORE_REQUIRED because this admin
    // holds no subscription. The button must follow the verdict.
    expect(gates.research).toBe("AVAILABLE");
    expect(gates.entitlement).toBe("CORE_REQUIRED");

    expect(canStartProof(subjectFrom(gates))).toBe(true);
    expect(proofBlockReason(subjectFrom(gates))).toBeNull();
  });

  it("3. owner-alpha switched off → disabled again", async () => {
    const slug = ALLOWLISTED!;
    await ensureProject(slug);
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: false }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [slug] },
    );
    expect(gates.research).not.toBe("AVAILABLE");
    expect(canStartProof(subjectFrom(gates))).toBe(false);
  });

  it("4. an ADMIN asking about a project outside the owner-alpha allowlist → disabled", async () => {
    const [offAllowlist] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("gate_off"), name: "Off Allowlist", status: "ACTIVE_CORE" })
      .returning();
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [offAllowlist.slug] },
    );
    expect(gates.research).not.toBe("AVAILABLE");
    expect(canStartProof(subjectFrom(gates))).toBe(false);
  });

  it("an ADMIN who already has an active job is still refused, for that reason", async () => {
    const slug = ALLOWLISTED!;
    await ensureProject(slug);
    const userId = await makeUser("ADMIN");
    const cfg = config({ research_enabled: false, internal_alpha_enabled: true });
    const before = await evaluateGates(ctx.db, cfg, {
      userId,
      status: "READY",
      route: "DEEP_RESEARCH",
      projectSlugs: [slug],
    });
    expect(canStartProof(subjectFrom(before))).toBe(true);

    const { createResearchJob } = await import("../src/server/jobs/research-jobs");
    const { topics } = await import("../src/server/db/schema");
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const project = await ensureProject(slug);
    await createResearchJob(ctx.db, ctx.boss, {
      userId,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "q",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "t" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: {
        level: "ARI_CORE",
        capability: "FRESH_RESEARCH",
        budget: DEFAULT_PRODUCT_CONFIG.budget_core,
      },
      demoLifetimeProofLimit: 0,
      origin: "OWNER_MANUAL_ALPHA",
    });

    const after = await evaluateGates(ctx.db, cfg, {
      userId,
      status: "READY",
      route: "DEEP_RESEARCH",
      projectSlugs: [slug],
    });
    expect(after.research).toBe("ACTIVE_JOB_EXISTS");
    expect(canStartProof(subjectFrom(after))).toBe(false);
    expect(proofBlockReason(subjectFrom(after))).toBe("ACTIVE_JOB_EXISTS");
  });
});

describe("Ask — the client owns no policy of its own (item 5)", () => {
  it("5. a client-side claim of entitlement cannot grant a Proof the server refused", () => {
    // Even handed a subject whose every other axis looks permissive, the
    // decision follows `research` alone.
    const refused = {
      interpretation: { status: "READY" as const, route: "DEEP_RESEARCH" },
      gates: { research: "CORE_REQUIRED", entitlement: "OK", scope: "SUPPORTED", demo: null },
    } as unknown as Parameters<typeof canStartProof>[0];
    expect(canStartProof(refused)).toBe(false);
    expect(proofBlockReason(refused)).toBe("CORE_REQUIRED");

    // ...and the converse: a permissive verdict is honoured even when the
    // subscription axis alone would refuse.
    const granted = {
      interpretation: { status: "READY" as const, route: "DEEP_RESEARCH" },
      gates: { research: "AVAILABLE", entitlement: "CORE_REQUIRED", scope: "SUPPORTED", demo: null },
    } as unknown as Parameters<typeof canStartProof>[0];
    expect(canStartProof(granted)).toBe(true);
  });

  it("5. the client module contains no owner-alpha policy to get wrong", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = (await readFile("src/client/proof-gate.ts", "utf-8"))
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    // No role, no allowlist, no configuration, no phases — it cannot
    // recreate the server's policy because it knows none of its inputs.
    for (const forbidden of [
      "ADMIN",
      "internal_alpha",
      "phased",
      "demo_project_slugs",
      "INTERNAL_ALPHA_LIVE_PROJECT_SLUGS",
      "raydium",
      "pump_fun",
    ]) {
      expect(code, `proof-gate must not mention ${forbidden}`).not.toContain(forbidden);
    }
    // And it reads exactly one gate field.
    expect(code).toContain("gates.research");
    expect(code).not.toContain("gates.entitlement");
    expect(code).not.toContain("gates.scope");
  });

  it("the Ask screen asks the shared decision instead of re-deriving one", async () => {
    const { readFile } = await import("node:fs/promises");
    const page = await readFile("app/(app)/ask/page.tsx", "utf-8");
    expect(page).toContain("canStartProof(subject)");
    expect(page).toContain("proofBlockReason(subject)");
    // The three raw-axis reads that caused the bug are gone.
    expect(page).not.toContain('gates.entitlement === "CORE_REQUIRED"');
    expect(page).not.toContain('gates.entitlement === "OK"');
    expect(page).not.toContain('gates.scope === "SUPPORTED"');
  });
});

describe("Ask — nothing else moved (items 6, 7)", () => {
  it("6. the Start Proof request payload is unchanged", async () => {
    const { readFile } = await import("node:fs/promises");
    const api = await readFile("src/client/api.ts", "utf-8");
    const call = api.slice(api.indexOf("startResearch"), api.indexOf("startResearch") + 600);
    // Exactly the two fields it has always sent.
    expect(call).toContain("interpretationId");
    expect(call).toContain("idempotencyKey");
    for (const word of ["phased", "acquisitionPhase", "capability", "SEARCHING", "role"]) {
      expect(call, `payload must not carry ${word}`).not.toContain(word);
    }
  });

  it("7. the backend gate is untouched: the same inputs still produce the same verdicts", async () => {
    // pump_fun is INSIDE demo_project_slugs, so this is the case that
    // always worked — proving the fix did not change server behaviour,
    // only which field the client believes.
    const userId = await makeUser("ADMIN");
    const gates = await evaluateGates(
      ctx.db,
      config({ research_enabled: false, internal_alpha_enabled: true }),
      { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: ["pump_fun"] },
    );
    expect(gates.research).toBe("AVAILABLE");
    expect(gates.entitlement).toBe("OK");
    expect(gates.scope).toBe("SUPPORTED");
    expect(canStartProof(subjectFrom(gates))).toBe(true);

    // And research_enabled=true still closes the owner-alpha branch for
    // everyone, exactly as D-123 requires.
    const publicCfg = config({ research_enabled: true, internal_alpha_enabled: true });
    const publicGates = await evaluateGates(ctx.db, publicCfg, {
      userId,
      status: "READY",
      route: "DEEP_RESEARCH",
      projectSlugs: ["pump_fun"],
    });
    expect(publicGates.research).toBe("AVAILABLE");
  });

  it("the product config the fix depends on is read from the server, never from the client", async () => {
    // phased_research_enabled must not reach the browser in any form.
    const { readFile } = await import("node:fs/promises");
    for (const file of ["src/client/api.ts", "src/client/proof-gate.ts", "app/(app)/ask/page.tsx"]) {
      const src = await readFile(file, "utf-8");
      expect(src, `${file} must not expose phased_research_enabled`).not.toContain(
        "phased_research_enabled",
      );
    }
    const rows = await ctx.db.select().from(productConfig).where(eq(productConfig.key, "phased_research_enabled"));
    if (rows.length > 0) expect(rows[0].value).toBe(false);
  });
});
