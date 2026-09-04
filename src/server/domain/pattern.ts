import { z } from "zod";

import { RESEARCH_INTENTS } from "../interpreter/schema";

// Pattern v1 — скелет Research Boundary Contract (phase-5-plan.md §4.1,
// canonical §14). 8 шагов Token Value Capture. CORE управляется человеком
// (D-022): переход v1→v2 — ручной, с регрессией; этот файл не меняется
// исполнением Фазы 5, только читается планировщиком и сидом.

export const PATTERN_STEP_NAMES = [
  "Economic Source",
  "Revenue Waterfall",
  "Allocation Mechanism",
  "Actual Execution",
  "Current Status + Freshness",
  "Token Destination + Recipient",
  "Net Token Effect",
  "Durability",
] as const;

export type PatternStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const patternStepSchema = z.object({
  step: z.number().int().min(1).max(8),
  name: z.string().min(1),
  question: z.string().min(1),
});

// D-060: компоненты шага живут в research_patterns.content — внутри CORE,
// который меняет человек (D-022). Ключ — номер шага строкой (jsonb),
// значение — фиксированный список компонентов, каждый из которых обязан
// быть покрыт пригодной памятью, чтобы шаг стал ALREADY_SATISFIED.
// Это контракт ТОЛЬКО Token Value Capture Pattern v1 — универсальная
// онтология не вводится.
const requiredComponentsSchema = z
  .record(z.string(), z.array(z.string().min(1)).min(1))
  .superRefine((rec, ctx) => {
    const keys = Object.keys(rec).sort();
    const expected = ["1", "2", "3", "4", "5", "6", "7", "8"];
    if (keys.length !== 8 || keys.some((k, i) => k !== expected[i])) {
      ctx.addIssue({
        code: "custom",
        message: `requiredComponents must cover exactly steps 1..8, got: ${keys.join(",")}`,
      });
    }
  });

// Phase 6, S5 (phase-6-s5-plan.md §5, §11.1, D-095) — ComponentRequirements
// live in Pattern/CORE content, additively, keyed by COMPONENT NAME (not
// step — a component name is unique across the whole Pattern v1 matrix).
// `ComponentReconciler` (component-reconciler.ts) CONSUMES this and never
// invents a fallback. Two distinct cases, per D-095 (see
// componentRequirementsFor below for the enforcement): an EXPLICIT entry
// with establishingClasses: [] is valid Pattern data (a human/CORE
// decision that this component structurally cannot be established,
// S5 plan §5 acceptance scenario Y); a component with NO entry at all is
// a CORE configuration failure — componentRequirementsFor throws
// PatternConfigurationError rather than silently defaulting to case A.
const evidenceSourceClassSchema = z.enum([
  "ONCHAIN_VERIFIABLE",
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
  "DATA_PROVIDER",
  "RESEARCH_MEDIA",
  "SOCIAL",
]);

const freshnessClassSchema = z.enum(["LOW_CHANGE", "MEDIUM_CHANGE", "HIGH_CHANGE"]);

const componentRequirementsEntrySchema = z.object({
  // §5 — the only source of establishment/contradiction/supersession
  // authority for this component (D-093: no global sourceClass ranking
  // exists anywhere else). Empty array is a legal, meaningful value: the
  // component structurally cannot be established (scenario Y).
  establishingClasses: z.array(evidenceSourceClassSchema),
  // §6.2 — whether establishing this component additionally requires a
  // provable currency basis (published_at inside the freshness window, or
  // fetched_at for ONCHAIN_VERIFIABLE).
  requiresCurrentState: z.boolean(),
  // §6.3 — whether establishing this component additionally requires the
  // establishing element's own normalized mechanism_state to indicate the
  // mechanism is actually LIVE (IMPLEMENTING downgrades to
  // PARTIALLY_SUPPORTED/STATE_NOT_FULLY_LIVE; PROPOSED/APPROVED/anything
  // else does not establish at all). Distinct from requiresCurrentState:
  // EXECUTION_EVIDENCE needs this gate without the freshness-window gate
  // (§5 table: "нет (но §6.3)").
  requiresLiveMechanismState: z.boolean(),
  freshnessClass: freshnessClassSchema,
  // §9.1 condition 1.
  tokenStateSensitive: z.boolean(),
  // §9.1 condition 3 — exact normalized-string equality only; S5 never
  // infers it. null = equality not established by Pattern data (the
  // common case for Pattern v1, which is not query-specific).
  requiredTokenState: z.string().min(1).nullable(),
  // ACQUISITION MINIMUM SAFE V1 (A) — the evidential PROPOSITION this
  // component must resolve, in one human-authored sentence.
  //
  // Why this is Pattern data and not a model's job: establishingClasses
  // already says WHICH classes may establish the component, but nothing
  // anywhere said WHAT would resolve it. Acquisition therefore had only
  // the component's NAME to search with, and a real run produced the
  // query "<project> net token effect mechanism" for NET_EFFECT — a label
  // search, not an evidence search. Letting the model infer the
  // requirement would make CORE methodology model-generated, which D-095
  // forbids; so the proposition is authored here, next to the classes it
  // pairs with, and is consumed verbatim.
  //
  // This is ACQUISITION guidance only. It never reaches S5: it cannot
  // establish, exclude, or reweigh any evidence, and admissibility stays
  // exactly establishingClasses + the axes above.
  //
  // Optional in the schema so a Pattern predating this field still parses
  // (same discipline as componentRequirements itself). Absent = no
  // guidance available, never a fabricated one.
  evidenceGoal: z.string().min(1).optional(),
});

export type ComponentRequirementsEntry = z.infer<typeof componentRequirementsEntrySchema>;

// Optional — a Pattern predating S5 (or any content JSON missing this key
// entirely) parses fine; componentRequirementsFor() below is what actually
// enforces "missing means no requirement", not this schema's optionality.
const componentRequirementsSchema = z.record(z.string(), componentRequirementsEntrySchema).optional();

// Phase 6, S7 (phase-6-s7-plan.md §5, §6, D-105) — ClaimRequirement is
// CORE data, authored by a human exactly like componentRequirements
// (D-095 discipline): S7 consumes it and never invents a requirement.
// Six kinds only (§5) — no free-text predicate, no requiredQuantity, no
// polarity field (§16/§7: nothing upstream can feed them).
const requirementKindSchema = z.enum([
  "COMPONENT_ESTABLISHED",
  "FLOW_RELATIONSHIP",
  "FLOW_ATTRIBUTE",
  "NET_EFFECT_ESTABLISHED",
  "LIFECYCLE",
  "DURABILITY_ESTABLISHED",
]);

const claimRequirementSchema = z.object({
  requirementId: z.string().min(1),
  kind: requirementKindSchema,
  optionality: z.enum(["REQUIRED", "OPTIONAL"]),
  components: z.array(z.string().min(1)).optional(),
  relationshipFrom: z.string().min(1).optional(),
  relationshipTo: z.string().min(1).optional(),
  attribute: z.enum(["valueSource", "direction", "recipientKind", "destinationKind", "tokenState"]).optional(),
  expectedValues: z.array(z.string().min(1)).optional(),
  expectedLifecycle: z.enum(["CURRENT", "HISTORICAL"]).optional(),
});

export type ClaimRequirement = z.infer<typeof claimRequirementSchema>;
export type RequirementKind = z.infer<typeof requirementKindSchema>;

// §28 — 8 v1 in-scope intents get a real requirement set; the other 3
// (UNKNOWN, SCENARIO_CAUSAL_IMPACT, CLAIM_FACT_CHECK) are handled by S7
// itself before ever reaching this lookup (§6, D-106) — they deliberately
// have no CORE entry here, and that absence is not a configuration error
// for them specifically (intentRequirementsFor is never called with one
// of those three).
const intentRequirementSetSchema = z.object({
  requirements: z.array(claimRequirementSchema).min(1),
  ceiling: z.enum(["PARTIALLY_SUPPORTED"]).optional(),
});

const intentRequirementsSchema = z.record(z.string(), intentRequirementSetSchema).optional();

export type IntentRequirementSet = z.infer<typeof intentRequirementSetSchema>;

// zod-контракт на content (phase-5-plan.md §5.2) — без него blind-регрессия
// будущей Фазы 10 непроверяема: Pattern v1 обязан оставаться ровно 8 шагами
// в фиксированном порядке.
export const patternContentSchema = z.object({
  steps: z.array(patternStepSchema).length(8),
  requiredComponents: requiredComponentsSchema,
  componentRequirements: componentRequirementsSchema,
  intentRequirements: intentRequirementsSchema,
});

export type PatternContent = z.infer<typeof patternContentSchema>;

export function requiredComponentsForStep(
  pattern: PatternContent,
  step: number,
): string[] {
  return pattern.requiredComponents[String(step)] ?? [];
}

// MEDIUM-3 (deep audit, phase-6-s5-audit.md) — D-095 draws a real
// distinction the previous NO_REQUIREMENT fallback erased:
//
//   A. An EXPLICIT entry with establishingClasses: [] is valid Pattern
//      DATA — a human/CORE decision that this component structurally
//      cannot be established (scenario Y). This is a legitimate
//      evidentiary outcome (INSUFFICIENT_EVIDENCE).
//   B. NO entry at all — the key absent from componentRequirements, or
//      componentRequirements itself absent from Pattern content (the
//      exact shape of a pre-S5 seeded Pattern row, deep audit DBP4) — is
//      NOT a Pattern decision about this component; CORE was simply never
//      configured for S5 reconciliation of it. Silently treating this as
//      case A turns "S5 not configured yet" into a false research
//      conclusion ("investigated, found nothing") for every component of
//      every job, forever, on any pre-migration database.
//
// Case B is therefore a CONFIGURATION failure, not an Evidence
// conclusion — componentRequirementsFor throws rather than returning a
// silent default, so the caller (component-reconciliation-store.ts) can
// surface it as a system/configuration error instead of persisting a
// false INSUFFICIENT_EVIDENCE row.
export class PatternConfigurationError extends Error {
  constructor(component: string) {
    super(
      `Pattern is missing componentRequirements for component "${component}" — CORE is not configured for S5 ` +
        `reconciliation of this component. This is a configuration failure, not an evidentiary conclusion (D-095).`,
    );
    this.name = "PatternConfigurationError";
  }
}

export function componentRequirementsFor(
  pattern: PatternContent,
  component: string,
): ComponentRequirementsEntry {
  const entry = pattern.componentRequirements?.[component];
  if (entry === undefined) {
    throw new PatternConfigurationError(component);
  }
  return entry;
}

// Phase 6, S7 (phase-6-s7-plan.md §6, §25, D-105, acceptance scenario AX)
// — same discipline as PatternConfigurationError: an in-scope intent
// (one of the 8 named in §28) missing its CORE entry is a configuration
// failure, never silently treated as "researched, found nothing" for
// every job carrying that intent. Callers must never invoke this for
// UNKNOWN / SCENARIO_CAUSAL_IMPACT / CLAIM_FACT_CHECK — those three are
// handled before this lookup is ever reached (§6, D-106).
export class IntentConfigurationError extends Error {
  constructor(intent: string) {
    super(
      `Pattern is missing intentRequirements for intent "${intent}" — CORE is not configured for S7 claim-support ` +
        `evaluation of this intent. This is a configuration failure, not an evidentiary conclusion (D-105).`,
    );
    this.name = "IntentConfigurationError";
  }
}

export function intentRequirementsFor(
  pattern: PatternContent,
  intent: string,
): IntentRequirementSet {
  const entry = pattern.intentRequirements?.[intent as (typeof RESEARCH_INTENTS)[number]];
  if (entry === undefined) {
    throw new IntentConfigurationError(intent);
  }
  return entry;
}

// Phase 6, S7 (phase-6-s7-plan.md §24) — a human-bumped version number
// for the intentRequirements CORE data itself, independent of
// patternVersion (a human can edit requirements without touching the
// Pattern). Bump this constant whenever intentRequirements changes so
// research_claim_support's key (§24) never silently serves a stale
// projection computed under a since-edited requirement set.
export const INTENT_REQUIREMENTS_VERSION = 1;

export const PATTERN_V1_CONTENT: PatternContent = {
  steps: [
    {
      step: 1,
      name: "Economic Source",
      question: "Where does the economic value the project claims come from?",
    },
    {
      step: 2,
      name: "Revenue Waterfall",
      question: "How does that value flow through the protocol before it reaches anyone?",
    },
    {
      step: 3,
      name: "Allocation Mechanism",
      question: "What mechanism decides how much of that value goes to the token?",
    },
    {
      step: 4,
      name: "Actual Execution",
      question: "Has that mechanism actually been executed, not just specified?",
    },
    {
      step: 5,
      name: "Current Status + Freshness",
      question: "Is the mechanism currently active, and how recently was that verified?",
    },
    {
      step: 6,
      name: "Token Destination + Recipient",
      question: "Where does the value land once it reaches the token — burn, buyback, staking, treasury?",
    },
    {
      step: 7,
      name: "Net Token Effect",
      question: "What is the net effect on the token after accounting for emissions and dilution?",
    },
    {
      step: 8,
      name: "Durability",
      question: "Is this mechanism durable, or contingent on conditions that could reverse it?",
    },
  ],
  // D-060: два многокомпонентных шага — намеренное содержательное суждение
  // (phase-5-plan.md §4.1a): «механизм описан» и «механизм санкционирован» —
  // разные факты (шаг 3); «куда ушла ценность» и «кто её держит» — тоже
  // разные (шаг 6). Остальные шесть шагов однокомпонентны.
  requiredComponents: {
    "1": ["SOURCE_OF_VALUE"],
    "2": ["FLOW_PATH"],
    "3": ["MECHANISM_SPEC", "GOVERNANCE_BASIS"],
    "4": ["EXECUTION_EVIDENCE"],
    "5": ["CURRENT_STATE"],
    "6": ["DESTINATION", "RECIPIENT"],
    "7": ["NET_EFFECT"],
    "8": ["DURABILITY_BASIS"],
  },
  // Phase 6, S5 (phase-6-s5-plan.md §5, matrix already approved by the
  // plan and reproduced here verbatim as Pattern DATA, D-095). SOCIAL
  // appears in no row — no component is establishable by it, however many
  // SOCIAL rows accumulate (D-074). requiresLiveMechanismState is set for
  // exactly the two components §6.3 names (CURRENT_STATE, EXECUTION_EVIDENCE);
  // requiresCurrentState (the freshness-window gate, §6.2) is set for
  // CURRENT_STATE only, per the table's own "нет (но §6.3)" annotation for
  // EXECUTION_EVIDENCE. tokenStateSensitive marks the three components
  // D-096 names explicitly (RECIPIENT, DESTINATION, NET_EFFECT).
  // requiredTokenState is null everywhere — Pattern v1 is not
  // query-specific; a real requiredTokenState is a test/S6 concept, never
  // invented here.
  componentRequirements: {
    SOURCE_OF_VALUE: {
      establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "identify the concrete economic activity that produces the value or cash flow in question, and the evidence that this activity actually generates it rather than being an aspiration",
    },
    FLOW_PATH: {
      establishingClasses: ["OFFICIAL_DOCS", "ONCHAIN_VERIFIABLE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "trace each hop the value takes from where it is produced to where it ends up, identifying the specific accounts, contracts, or entities it passes through at every step",
    },
    MECHANISM_SPEC: {
      establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "find the specification of how the mechanism is defined to work - its rules, triggers, formulas, rates and conditions - as stated by the project itself or its governing documents",
    },
    GOVERNANCE_BASIS: {
      establishingClasses: ["GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "find the governing decision, vote, proposal or charter that authorises the mechanism, and what it permits, requires or constrains",
    },
    EXECUTION_EVIDENCE: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresCurrentState: false,
      requiresLiveMechanismState: true,
      freshnessClass: "MEDIUM_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "find evidence that the mechanism has actually executed in practice - real transactions, operations or reported executions - not merely that it is specified or announced",
    },
    CURRENT_STATE: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"],
      requiresCurrentState: true,
      // §6.3: CURRENT_STATE reports whatever the current state actually IS
      // (LIVE, DEPRECATED, PAUSED, ... are all legitimate answers) — it is
      // NOT gated to only LIVE. requiresLiveMechanismState stays false here;
      // it is EXECUTION_EVIDENCE's gate (below), not this component's.
      requiresLiveMechanismState: false,
      freshnessClass: "HIGH_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "determine whether the mechanism is operating right now, and if not whether it is paused, deprecated, superseded or not yet started, with evidence current enough to prove present state",
    },
    DESTINATION: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
      evidenceGoal:
        "identify where the assets end up after the mechanism executes - the specific destination account, contract, address or pool - and whether that destination retains, redistributes or retires them",
    },
    RECIPIENT: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
      evidenceGoal:
        "identify who ultimately receives the economic benefit, and whether that party is the token holder, the protocol treasury, the team, liquidity providers or another party",
    },
    NET_EFFECT: {
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: true,
      requiredTokenState: null,
      evidenceGoal:
        "determine what happened to the relevant tokens or assets after the mechanism executed, and whether circulating supply, total supply, holder ownership or another economically relevant state actually changed as a result",
    },
    DURABILITY_BASIS: {
      establishingClasses: ["GOVERNANCE", "OFFICIAL_DOCS"],
      requiresCurrentState: false,
      requiresLiveMechanismState: false,
      freshnessClass: "LOW_CHANGE",
      tokenStateSensitive: false,
      requiredTokenState: null,
      evidenceGoal:
        "determine how durable the mechanism is - whether it is permanent, time-limited, discretionary or revocable - and what could change or end it",
    },
  },
  // Phase 6, S7 (phase-6-s7-plan.md §28) — the 8 in-scope v1 intents.
  // Each requirement set is human-authored CORE data (D-095 discipline):
  // S7 consumes these atoms and invents none. UNKNOWN, SCENARIO_CAUSAL_IMPACT,
  // and CLAIM_FACT_CHECK deliberately have no entry — see intentRequirementsFor.
  intentRequirements: {
    PROTOCOL_REVENUE_TO_TOKEN: {
      requirements: [
        { requirementId: "PRT-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "PRT-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
    },
    PASSIVE_HOLDER_OUTCOME: {
      requirements: [
        { requirementId: "PHO-1", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "recipientKind", expectedValues: ["PASSIVE_HOLDER"] },
      ],
    },
    REWARD_SOURCE: {
      requirements: [
        { requirementId: "RS-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "RS-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
    },
    BURN_OR_SUPPLY_EFFECT: {
      requirements: [{ requirementId: "BSE-1", kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED" }],
    },
    MECHANISM_CURRENT_STATE: {
      requirements: [{ requirementId: "MCS-1", kind: "LIFECYCLE", optionality: "REQUIRED", expectedLifecycle: "CURRENT" }],
    },
    USAGE_TO_TOKEN_LINKAGE: {
      requirements: [
        { requirementId: "UTL-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "UTL-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
    },
    VALUE_CAPTURE: {
      requirements: [
        { requirementId: "VC-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "VC-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
        { requirementId: "VC-3", kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED" },
      ],
    },
    TOKEN_UTILITY: {
      requirements: [
        { requirementId: "TU-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        {
          requirementId: "TU-2",
          kind: "FLOW_ATTRIBUTE",
          optionality: "OPTIONAL",
          attribute: "recipientKind",
          expectedValues: ["PASSIVE_HOLDER", "STAKER", "NODE_OPERATOR", "TREASURY", "LP", "EXTERNAL"],
        },
      ],
    },
  },
};

// Валидируется на модуле, а не только в сиде: искажённая константа не
// должна молча пройти в продакшен.
patternContentSchema.parse(PATTERN_V1_CONTENT);
