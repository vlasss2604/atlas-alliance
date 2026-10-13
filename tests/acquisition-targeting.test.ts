import { describe, expect, it } from "vitest";

import {
  blendQueries,
  buildTargetedQueries,
  genericSearchMayEstablish,
  MAX_TARGETED_QUERIES_PER_ATTEMPT,
} from "../src/server/engine/acquisition-targeting";
import {
  componentSearchAllowance,
  intentRequiredComponents,
} from "../src/server/engine/budget-fairness";
import {
  classRequiresConfirmedRoute,
  isTestNetworkHost,
  resolveSourceClass,
  targetDomainsForClass,
} from "../src/server/engine/source-authority";

// D-129/D-130 — five live owner-alpha runs collected 233 evidence rows and
// admitted ZERO. Every component the engine reached admits only
// OFFICIAL_DOCS / GOVERNANCE / ONCHAIN_VERIFIABLE, but acquisition issued
// generic web queries, the search provider returned aggregator/blog pages,
// and S5 correctly discarded all of them as CLASS_NOT_ADMISSIBLE. Separately,
// a flat 3-queries-per-component cap against a 12-query ceiling meant the
// first four components consumed the entire axis: pattern steps 5-8 were
// never attempted in ANY run, including NET_EFFECT (step 7) — the single
// component a BURN_OR_SUPPLY_EFFECT question actually requires.

describe("acquisition targeting — class-aware query steering (D-129)", () => {
  it("A. a component requiring authoritative classes gets site-targeted queries at hosts the classifier already recognises", () => {
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE", "GOVERNANCE"],
      // D-132: only human-confirmed, project-specific locators are safe
      // targets. Without these the platforms are shared multi-tenant hosts
      // and are deliberately not targeted at all.
      confirmedRouteDomainsByClass: {
        ONCHAIN_VERIFIABLE: ["solscan.io"],
        GOVERNANCE: ["snapshot.org"],
      },
      baseQueries: ["pump.fun buyback supply effect"],
    });
    expect(targetedQueries.length).toBeGreaterThan(0);
    expect(targetedQueries.length).toBeLessThanOrEqual(MAX_TARGETED_QUERIES_PER_ATTEMPT);
    // Every targeted query must name a domain that resolveSourceClass
    // independently classifies into a class this component admits —
    // otherwise the steering would be spending budget on hosts that can
    // never yield admissible evidence.
    for (const q of targetedQueries) {
      const domain = /^site:(\S+)\s/.exec(q)?.[1];
      expect(domain, `no site: term in ${q}`).toBeTruthy();
      const cls = resolveSourceClass(`https://${domain}/some/path`, "OTHER", null);
      expect(["ONCHAIN_VERIFIABLE", "GOVERNANCE"]).toContain(cls);
    }
    // The model's topic text is preserved verbatim; only the site: term
    // is code-owned.
    for (const q of targetedQueries) {
      expect(q.endsWith("pump.fun buyback supply effect")).toBe(true);
    }
  });

  it("D. targeting never changes admissibility — it only aims search; SOCIAL stays SOCIAL", () => {
    // A steered query cannot make an inadmissible host admissible.
    expect(resolveSourceClass("https://tokenomics.com/x", "OTHER", null)).toBe("SOCIAL");
    expect(resolveSourceClass("https://some-random-blog.example/x", "OTHER", null)).toBe("SOCIAL");
    // And a component that admits only authoritative classes never gets a
    // SOCIAL domain proposed as a target for those classes.
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      confirmedRouteDomainsByClass: { ONCHAIN_VERIFIABLE: ["solscan.io"] },
      baseQueries: ["supply"],
    });
    for (const q of targetedQueries) {
      const domain = /^site:(\S+)\s/.exec(q)?.[1] ?? "";
      expect(resolveSourceClass(`https://${domain}/p`, "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
    }
  });

  it("E. SOCIAL remains non-admissible where the Pattern prohibits it (targeting cannot launder it)", () => {
    // SOCIAL has a code-owned list (it is a real class), but a component
    // whose establishingClasses exclude it never receives SOCIAL targets.
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["GOVERNANCE"],
      confirmedRouteDomainsByClass: { GOVERNANCE: ["snapshot.org"] },
      baseQueries: ["governance proposal"],
    });
    for (const q of targetedQueries) {
      const domain = /^site:(\S+)\s/.exec(q)?.[1] ?? "";
      expect(resolveSourceClass(`https://${domain}/p`, "OTHER", null)).not.toBe("SOCIAL");
    }
  });

  it("C. the same domain reached twice never produces duplicate targeted queries (no duplicate source strength)", () => {
    const { targetedQueries } = buildTargetedQueries({
      // Same class twice, and a confirmed route domain that also appears
      // in the platform list — neither may yield the domain twice.
      establishingClasses: ["GOVERNANCE", "GOVERNANCE"],
      confirmedRouteDomainsByClass: { GOVERNANCE: ["snapshot.org"] },
      baseQueries: ["proposal"],
    });
    const domains = targetedQueries.map((q) => /^site:(\S+)\s/.exec(q)?.[1]);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("OFFICIAL_DOCS is reachable ONLY through a human-confirmed SOURCE_ROUTE, never invented", () => {
    expect(classRequiresConfirmedRoute("OFFICIAL_DOCS")).toBe(true);
    expect(classRequiresConfirmedRoute("OFFICIAL_REPORT")).toBe(true);
    expect(classRequiresConfirmedRoute("ONCHAIN_VERIFIABLE")).toBe(false);
    // With no confirmed route, the class yields no targets and is
    // reported as unreachable rather than silently searched for.
    expect(targetDomainsForClass("OFFICIAL_DOCS")).toEqual([]);
    const { targetedQueries, unreachableClasses } = buildTargetedQueries({
      establishingClasses: ["OFFICIAL_DOCS"],
      baseQueries: ["docs"],
    });
    expect(targetedQueries).toEqual([]);
    expect(unreachableClasses).toContain("OFFICIAL_DOCS");
    // With one confirmed by a human, it becomes targetable.
    const confirmed = buildTargetedQueries({
      establishingClasses: ["OFFICIAL_DOCS"],
      confirmedRouteDomainsByClass: { OFFICIAL_DOCS: ["docs.example-project.org"] },
      baseQueries: ["docs"],
    });
    expect(confirmed.targetedQueries[0]).toBe("site:docs.example-project.org docs");
    expect(confirmed.unreachableClasses).not.toContain("OFFICIAL_DOCS");
  });

  it("always preserves at least one untargeted model query when more than one query is allowed", () => {
    const blended = blendQueries(
      ["site:solscan.io supply", "site:solana.fm supply"],
      ["pump.fun token supply mechanics"],
      3,
    );
    expect(blended).toContain("pump.fun token supply mechanics");
    expect(blended.length).toBeLessThanOrEqual(3);
  });

  it("A. spends a single-query allowance on the TARGETED query when generic search cannot establish the component", () => {
    // The live regression this encodes: with a fair-share allowance of 1,
    // reserving that slot for the model's generic query meant targeting
    // never fired at all, and the component's only search returned
    // SOCIAL — guaranteed inadmissible.
    const blended = blendQueries(
      ["site:solscan.io supply"],
      ["generic supply question"],
      1,
      /* genericMayEstablish */ false,
    );
    expect(blended).toEqual(["site:solscan.io supply"]);
  });

  it("a single-query allowance always goes to a targeted query when one exists — it is already aimed at an admitted class", () => {
    const blended = blendQueries(
      ["site:defillama.com supply"],
      ["generic supply question"],
      1,
      /* genericMayEstablish */ true,
    );
    expect(blended).toEqual(["site:defillama.com supply"]);
  });

  it("genericMayEstablish decides the RESERVED generic slot once more than one query is allowed", () => {
    // generic CAN establish -> one slot is held back for the model query
    const withGeneric = blendQueries(
      ["site:defillama.com a", "site:dune.com a"],
      ["model query a"],
      2,
      true,
    );
    expect(withGeneric).toContain("model query a");
    // generic CANNOT establish -> both slots go to targeted queries
    const withoutGeneric = blendQueries(
      ["site:solscan.io a", "site:solana.fm a"],
      ["model query a"],
      2,
      false,
    );
    expect(withoutGeneric).toEqual(["site:solscan.io a", "site:solana.fm a"]);
  });

  it("genericSearchMayEstablish reflects the component's own admitted classes", () => {
    expect(genericSearchMayEstablish(["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE"])).toBe(false);
    expect(genericSearchMayEstablish(["ONCHAIN_VERIFIABLE", "DATA_PROVIDER"])).toBe(true);
    expect(genericSearchMayEstablish(["RESEARCH_MEDIA"])).toBe(true);
    expect(genericSearchMayEstablish([])).toBe(false);
  });

  it("G. contains no project-specific hardcoding — the same call shape works for any project", () => {
    const a = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      confirmedRouteDomainsByClass: { ONCHAIN_VERIFIABLE: ["solscan.io"] },
      baseQueries: ["alpha protocol emissions"],
    });
    const b = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      confirmedRouteDomainsByClass: { ONCHAIN_VERIFIABLE: ["solscan.io"] },
      baseQueries: ["beta protocol emissions"],
    });
    expect(a.targetedQueries.map((q) => q.replace(/ .*$/, ""))).toEqual(
      b.targetedQueries.map((q) => q.replace(/ .*$/, "")),
    );
    const joined = JSON.stringify([a, b]).toLowerCase();
    expect(joined).not.toContain("pump");
  });
});

describe("budget fairness — later intent-critical components cannot be starved (D-130)", () => {
  it("B. walking a 10-component queue with a 12-query ceiling leaves budget for the last component", () => {
    const maxSearchQueries = 12;
    const workQueueSize = 10;
    let reserved = 0;
    const allowances: number[] = [];
    for (let i = 0; i < workQueueSize; i += 1) {
      const allowance = componentSearchAllowance({
        maxSearchQueries,
        alreadyReserved: reserved,
        workQueueSize,
        remainingComponents: workQueueSize - i,
        isIntentRequired: false,
        hardCapPerAttempt: 3,
      });
      allowances.push(allowance);
      reserved += allowance;
    }
    // Every component, including the last, gets a usable share — this is
    // the anti-starvation property. (The allowance is a PROPOSAL cap; the
    // real ceiling stays with the atomic reservation, which is why the
    // final component may propose more than the literal remainder — see
    // componentSearchAllowance's remainingComponents<=1 note.)
    expect(allowances.every((a) => a >= 1)).toBe(true);
    // The pre-fix behaviour (3,3,3,3,0,0,0,0,0,0) is gone: no component
    // past the fourth is left with nothing.
    expect(allowances.slice(4).every((a) => a >= 1)).toBe(true);
    // Early components must not each grab the full per-attempt cap while
    // seven others still wait.
    expect(allowances.slice(0, 6).every((a) => a < 3)).toBe(true);
  });

  it("F. an intent-required component still receives execution capacity late in the queue", () => {
    // Nine components already spent their fair share; NET_EFFECT is last
    // and is the one the intent actually requires.
    const allowance = componentSearchAllowance({
      maxSearchQueries: 12,
      alreadyReserved: 9,
      workQueueSize: 10,
      remainingComponents: 1,
      isIntentRequired: true,
      hardCapPerAttempt: 3,
    });
    expect(allowance).toBeGreaterThanOrEqual(1);
  });

  it("never hands out budget that would exceed the frozen ceiling", () => {
    const allowance = componentSearchAllowance({
      maxSearchQueries: 12,
      alreadyReserved: 12,
      workQueueSize: 10,
      remainingComponents: 3,
      isIntentRequired: true,
      hardCapPerAttempt: 3,
    });
    expect(allowance).toBe(0);
  });

  it("F. BURN_OR_SUPPLY_EFFECT resolves NET_EFFECT as intent-required from a kind-only requirement", () => {
    // The real CORE shape for this intent: one REQUIRED requirement with
    // a kind and NO components[] array. Reading components[] alone would
    // wrongly conclude the intent requires nothing.
    const required = intentRequiredComponents({
      requirements: [
        { kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED", requirementId: "BSE-1" } as never,
      ],
    });
    expect(required.has("NET_EFFECT")).toBe(true);
  });

  it("reads components[] and flow endpoints too, and ignores OPTIONAL requirements", () => {
    const required = intentRequiredComponents({
      requirements: [
        { kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] } as never,
        { kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "FLOW_PATH", relationshipTo: "RECIPIENT" } as never,
        { kind: "DURABILITY_ESTABLISHED", optionality: "OPTIONAL" } as never,
      ],
    });
    expect([...required].sort()).toEqual(["FLOW_PATH", "RECIPIENT", "SOURCE_OF_VALUE"]);
    expect(required.has("DURABILITY_BASIS")).toBe(false);
  });
});

// D-131 — a live run admitted sepolia.etherscan.io as ONCHAIN_VERIFIABLE
// and used it to PARTIALLY_SUPPORT a NET_EFFECT claim about token supply.
// matchesPlatformDomain treats any subdomain of a recognized explorer as
// that explorer, which silently promoted every test network to
// production-grade on-chain authority. A testnet's balances and supplies
// are free to mint and prove nothing about a real asset.
describe("source authority — test networks are never production on-chain authority (D-131)", () => {
  it("classifies testnet explorer subdomains as SOCIAL, not ONCHAIN_VERIFIABLE", () => {
    for (const url of [
      "https://sepolia.etherscan.io/token/0x38ef1520464a8b2b67d8408996e68a814e6479d8",
      "https://goerli.etherscan.io/address/0xabc",
      "https://testnet.bscscan.com/token/0xdef",
      "https://mumbai.polygonscan.com/tx/0x1",
    ]) {
      expect(resolveSourceClass(url, "OTHER", null), url).toBe("SOCIAL");
    }
  });

  it("a testnet host cannot be rescued into ONCHAIN_VERIFIABLE by sourceType", () => {
    expect(resolveSourceClass("https://sepolia.etherscan.io/token/0x1", "ONCHAIN", null)).toBe("SOCIAL");
  });

  it("mainnet explorers are unaffected", () => {
    expect(resolveSourceClass("https://etherscan.io/token/0x1", "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
    expect(resolveSourceClass("https://solscan.io/token/abc", "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
    expect(resolveSourceClass("https://basescan.org/token/0x1", "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
  });

  it("does not catch an unrelated host that merely contains the text inside a longer label", () => {
    expect(isTestNetworkHost("https://sepoliaanalytics.example.com/x")).toBe(false);
    expect(isTestNetworkHost("https://sepolia.etherscan.io/x")).toBe(true);
  });
});

// D-132 — the live false positive this exists to prevent.
//
// A run steered `site:etherscan.io pump.fun ...` and admitted an
// unrelated Ethereum ERC-20 ("PPF") plus a Sepolia testnet token, then
// used them to PARTIALLY_SUPPORT NET_EFFECT and FLOW_PATH claims about
// $PUMP — a Solana asset. Wrong chain, wrong contract, wrong asset,
// presented as on-chain proof. Every class-owned domain list is a SHARED
// MULTI-TENANT platform, so `site:<platform> <project name>` returns a
// page that merely MATCHED THE NAME, never a verified page about this
// project's entity.
describe("acquisition targeting — shared platforms need a confirmed project locator (D-132)", () => {
  it("does NOT target a shared explorer platform when the project has no confirmed locator", () => {
    const { targetedQueries, unreachableClasses } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      baseQueries: ["pump.fun buyback supply effect"],
    });
    // This is the exact query shape that produced the false positive.
    expect(targetedQueries).toEqual([]);
    expect(targetedQueries.some((q) => q.includes("etherscan.io"))).toBe(false);
    // And the reason is reported, not silently swallowed.
    expect(unreachableClasses).toContain("ONCHAIN_VERIFIABLE");
  });

  it("does NOT target shared governance or data-provider platforms unconfirmed either", () => {
    for (const cls of ["GOVERNANCE", "DATA_PROVIDER", "RESEARCH_MEDIA"] as const) {
      const { targetedQueries, unreachableClasses } = buildTargetedQueries({
        establishingClasses: [cls],
        baseQueries: ["anything"],
      });
      expect(targetedQueries, cls).toEqual([]);
      expect(unreachableClasses, cls).toContain(cls);
    }
  });

  it("targets ONLY the human-confirmed domain, never the rest of the platform list", () => {
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["GOVERNANCE"],
      confirmedRouteDomainsByClass: { GOVERNANCE: ["snapshot.org"] },
      baseQueries: ["supply"],
    });
    expect(targetedQueries).toEqual(["site:snapshot.org supply"]);
    // The confirmation for snapshot.org must not drag in every other
    // governance platform the code-owned list happens to contain.
    expect(targetedQueries.some((q) => q.includes("tally.xyz"))).toBe(false);
    expect(targetedQueries.some((q) => q.includes("commonwealth.im"))).toBe(false);
  });

  it("D-133 tightened ONCHAIN_VERIFIABLE further: a confirmed DOMAIN is not enough, only a confirmed ADDRESS", () => {
    // A shared explorer stays unsafe when all we have is "this explorer
    // is relevant" — that says nothing about WHICH token page is ours.
    const { targetedQueries, unreachableClasses } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      confirmedRouteDomainsByClass: { ONCHAIN_VERIFIABLE: ["solscan.io"] },
      baseQueries: ["supply"],
    });
    expect(targetedQueries).toEqual([]);
    expect(unreachableClasses).toContain("ONCHAIN_VERIFIABLE");
  });

  it("a confirmed locator for one class never leaks into another class", () => {
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE", "GOVERNANCE"],
      confirmedRouteDomainsByClass: { GOVERNANCE: ["snapshot.org"] },
      baseQueries: ["x"],
    });
    expect(targetedQueries).toEqual(["site:snapshot.org x"]);
  });
});
