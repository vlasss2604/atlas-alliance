import type { ExtractedFact } from "./providers/types";
import type { OnchainArtifact } from "./providers/onchain-types";
import {
  deriveDecodedExchange,
  EXCHANGE_DOES_NOT_PROVE,
} from "./onchain-exchange-decoding";
import {
  deriveReciprocalAssetFlows,
  RECIPROCAL_FLOW_DOES_NOT_PROVE,
} from "./onchain-transaction-flow";

// Deterministic on-chain fact synthesis (owner-approved: structured chain
// facts BYPASS EvidenceExtractor).
//
// An RPC response is already exact and typed. Asking a model to restate it
// would add cost, latency and hallucination risk to data that needs none,
// and would re-admit the model into a path where it has no authority. Every
// ExtractedFact field is derived here by code:
//
//   supportFragment — a literal slice of the artifact's canonical JSON, so
//                     traceability is exact rather than paraphrased
//   statement       — a code template over validated values
//   directness      — per fact kind, fixed
//   relationship    — per fact kind, fixed
//   doesNotProve    — HUMAN-AUTHORED CORE methodology data (below)
//
// The model is not merely unused here; there is no seam for it.
//
// Nothing in this file is project-specific: every value comes from the
// artifact, and every sentence is written in terms of "the token"/"the
// account"/"this transaction".

// ---- doesNotProve: human-authored CORE methodology data ---------------
//
// This is the discipline that keeps a deterministic chain reading from
// silently implying an economic conclusion. Each entry states, in product
// language, exactly what the observation does NOT establish. Authored by
// hand, alongside the Pattern's evidenceGoal data — never generated.
export const ONCHAIN_DOES_NOT_PROVE = {
  TOKEN_SUPPLY:
    "This is the token's total supply as recorded on-chain at the observed slot. It does not establish " +
    "circulating supply, which is a definitional and economic concept rather than a chain value; it does not " +
    "show how the supply changed over time; and it does not establish why any change occurred.",
  ACCOUNT_INFO:
    "This shows that the account exists on-chain and which program owns it. It does not establish who controls " +
    "the account, what role it plays in any mechanism, or whether it is a treasury, a vault, a burn address or " +
    "an ordinary holder — those are economic labels, not chain facts.",
  // The account IS this project's token account. What that does and does
  // not mean is the whole reason this entry is authored by hand.
  ACCOUNT_TOKEN_RELATION:
    "This shows that the queried account is an SPL token account for this project's confirmed mint, as parsed " +
    "by the node at the observed slot. It does not establish who controls the account, how any balance in it " +
    "arrived, that any token ever moved through it, what role it plays in any mechanism, or whether it is a " +
    "treasury, a vault, a burn address or an ordinary holder. A document calling this address something is a " +
    "separate claim, established separately, and this observation neither confirms nor contradicts it.",
  // The account is a token account for SOMEONE ELSE'S mint. The point of
  // this entry is that the reader must not carry the project across.
  ACCOUNT_TOKEN_RELATION_FOREIGN:
    "This shows that the queried account is an SPL token account for a mint that is NOT this project's " +
    "confirmed mint. It says nothing about this project's token: the account holds a different asset. That a " +
    "document about this project named this address does not make the account this project's, and no " +
    "conclusion about this project's supply, holdings or mechanisms may rest on it.",
  TOKEN_ACCOUNT_BALANCE:
    "This is the token balance held by the account at the observed slot. It does not establish how the balance " +
    "arrived there, who controls the account, whether the holding is permanent, or what the holding means " +
    "economically for token holders.",
  SIGNATURES_FOR_ADDRESS:
    "These are transactions involving the address at the observed slot range. It does not establish what any of " +
    "them did, that they relate to any particular mechanism, or that the list is complete beyond the queried " +
    "window.",
  // "Owner" is the RPC.s own field name and the limit of what it says. The
  // owner of a token account may be a system account, a program-derived
  // address, a multisig or an authority — calling it a wallet asserts a
  // shape and an agency the response never reported.
  TOKEN_ACCOUNTS_BY_OWNER:
    "This shows which SPL token accounts the queried address owns for the queried mint, and their balances, " +
    "at the observed slot. It does not establish how any balance got there, who funded it, who controls the " +
    "owning address beyond the owner field the RPC reports, what role it plays in any mechanism, that any " +
    "token was burned or bought back, or that circulating or total supply changed. A balance is a position at " +
    "a moment, never a history and never a purpose.",
  TRANSACTION_DETAIL:
    "This is the on-chain content of one transaction. It does not establish the economic purpose of the " +
    "transaction, who funded it, or that it belongs to any particular mechanism or policy.",
  // A native lamport transfer whose destination happens to be a token
  // account. The destination's OWNER is the RPC's own metadata; everything
  // about why the lamports moved is not.
  NATIVE_TRANSFER:
    "This is a transfer of native SOL recorded in one transaction, and the owner reported for the destination " +
    "account. It does not establish why the transfer was made, what it paid for, who controls either party, " +
    "where the lamports came from, or that anything was received in return. A syncNative instruction converts " +
    "delivered lamports into a wrapped-SOL balance; it says nothing about purpose either. Where the sender " +
    "funded an account it owns and that account paid someone else, the two amounts are stated separately " +
    "because they are separate movements: nothing here establishes that what arrived is what went on, or what " +
    "any remainder was for. An account whose owner is named by a same-transaction instruction that establishes " +
    "ownership is reported on that basis, which says who owns it and nothing more about what it is for.",
  // A token transfer between two accounts whose owners the RPC reported.
  TOKEN_TRANSFER:
    "This is a transfer of the stated mint between two token accounts in one transaction, with the owners the " +
    "transaction's balance metadata reports for each. It does not establish why the tokens moved, who decided " +
    "it, what if anything was given for them, who controls either owner, or that the tokens were bought, " +
    "sold, burned or destroyed. A transfer is a movement, never a purchase and never a destruction.",
  // Owner-specified verbatim requirements for the burn fact.
  BURN:
    "This is a genuine SPL Token burn instruction executed on-chain: the stated amount of the stated mint was " +
    "destroyed from the stated token account. It does NOT prove who economically funded the purchase of those " +
    "tokens; it does NOT prove the burned tokens came from a buyback; it does NOT prove that a broader buyback " +
    "policy exists; and it does NOT establish circulating-supply semantics beyond the observed on-chain effect. " +
    "Linking this burn to a buyback mechanism requires separate admitted evidence.",
  // B2 — the arithmetic ceiling of an interval, stated as narrowly as the
  // arithmetic itself. The number is exact and says nothing about cause.
  TOTAL_SUPPLY_DELTA:
    "This is the exact change in the token's on-chain total supply between two observed slots, computed from " +
    "two deterministic total-supply readings. It does not establish WHY the supply changed, what was minted " +
    "or burned inside the interval, or that any mechanism, buyback or policy caused any part of the change: " +
    "the number is the NET of everything that happened between the two slots. It does not establish " +
    "circulating supply, which is a definitional and economic concept rather than a chain value. A decrease " +
    "is not proof of a burn, an increase is not proof of an issuance policy, and no change is not proof that " +
    "nothing happened.",
} as const;

// ---- the fact KIND: closed, code-owned, model-unreachable -------------
//
// WHY THIS EXISTS AT ALL. Every sentence in ONCHAIN_DOES_NOT_PROVE above
// states a real semantic boundary — a transfer is not a burn, a balance is
// not a history, a supply level is not a supply change — and until now all
// of them were PROSE ON A ROW that no code could read. Reconciliation
// therefore could not tell a burn from a balance, and NET_EFFECT could be
// established by either.
//
// The kind is known here, at synthesis, and was discarded one line later.
// Persisting it is what turns those sentences into rules a machine can
// enforce.
//
// IT CANNOT BE FORGED. This vocabulary is reachable only from this file's
// own synthesis, which runs on a validated RPC artifact and bypasses the
// model entirely. It is deliberately NOT a field on `ExtractedFact` — the
// model's output type — so no extraction, no lexical classifier and no
// document can ever produce one. `SynthesizedFact` below is the only
// carrier, and `persistOnchainArtifactAndFacts` is the only writer.
export const ONCHAIN_FACT_KINDS = [
  "TOKEN_SUPPLY",
  "ACCOUNT_INFO",
  "ACCOUNT_TOKEN_RELATION",
  "ACCOUNT_TOKEN_RELATION_FOREIGN",
  "TOKEN_ACCOUNT_BALANCE",
  "TOKEN_ACCOUNTS_BY_OWNER",
  "SIGNATURES_FOR_ADDRESS",
  "TRANSACTION_DETAIL",
  "NATIVE_TRANSFER",
  "TOKEN_TRANSFER",
  "BURN",
  "RECIPROCAL_ASSET_FLOW",
  "DECODED_EXCHANGE",
  // DERIVED FROM TWO ARTIFACTS, UNLIKE EVERY KIND ABOVE IT. Its provenance
  // lives in evidence_onchain_artifact_inputs (FROM = t0, TO = t1), and the
  // singular evidence.onchain_artifact_id is NULL for such a row precisely
  // because no single artifact established it.
  //
  // ADDING IT GRANTS NOTHING. It is deliberately absent from
  // GROSS_SUPPLY_REDUCTION_FACT_KINDS (a net change is not a destruction
  // event) and from APPLICABLE_COMPONENTS_BY_KIND (nothing may read it
  // across components yet). Whether a delta may ever qualify NET_EFFECT is
  // a separate, unapproved decision.
  "TOTAL_SUPPLY_DELTA",
] as const;

export type OnchainFactKind = (typeof ONCHAIN_FACT_KINDS)[number];

// THE ONE KIND THAT IS A SUPPLY-REDUCING EVENT.
//
// A single named set rather than a check scattered across callers, because
// the whole value of this round is that exactly one on-chain observation
// destroys tokens and every other one does not. BURN is a GROSS reduction
// event: it says the stated amount of the stated mint was destroyed, and
// it says nothing about what funded it or what else happened to supply in
// the same interval — see ONCHAIN_DOES_NOT_PROVE.BURN.
export const GROSS_SUPPLY_REDUCTION_FACT_KINDS: readonly OnchainFactKind[] = ["BURN"];

export function isGrossSupplyReductionFact(kind: string | null | undefined): boolean {
  return kind !== null && kind !== undefined
    ? (GROSS_SUPPLY_REDUCTION_FACT_KINDS as readonly string[]).includes(kind)
    : false;
}

// ---- ONE FACT, THE COMPONENTS IT IS RELEVANT TO -----------------------
//
// A deterministic chain observation is filed under the component whose
// acquisition produced it. That is correct provenance and, on its own, it
// silently lost a real semantic: a transaction can only be reached by
// EXECUTION_EVIDENCE (it is the only component permitted the signature ->
// transaction promotion), so a BURN — the one observation that destroys
// tokens — was filed at EXECUTION_EVIDENCE and was invisible to
// NET_EFFECT, the component whose entire question is whether supply
// changed. NET_EFFECT could therefore never see the only fact that could
// answer it, in any live run.
//
// THIS IS AN APPLICABILITY MAP, NOT A COPY. The Evidence row stays where
// it was written, once, with one artifact and one provenance chain. What
// this declares is which OTHER components may READ it. Nothing is
// duplicated, no second row is created, no artifact is referenced twice,
// and no count grows.
//
// CLOSED, CODE-OWNED, AND DELIBERATELY TINY. One entry, because one is
// what current semantics justify:
//
//   BURN -> NET_EFFECT   A burn destroys tokens. That is a supply fact by
//                        definition, and it is the only kind that is.
//
// Every other kind is absent on purpose, and the absences are the
// substance of this map:
//
//   TOKEN_ACCOUNTS_BY_OWNER / TOKEN_ACCOUNT_BALANCE — a position at a
//     moment. Holding a token is not reducing supply, and letting a
//     balance reach NET_EFFECT would re-open exactly the false positive
//     B1 closed.
//   TOKEN_TRANSFER / NATIVE_TRANSFER / RECIPROCAL_ASSET_FLOW — a
//     movement. Tokens moved; none stopped existing.
//   DECODED_EXCHANGE — a purchase. Buying a token creates no supply
//     change whatever; this is the "buyback is not burn" boundary itself.
//   TOKEN_SUPPLY — a level, not a change, and NET_EFFECT already acquires
//     it directly (INTENTS_BY_COMPONENT). Nothing to cross.
//   ACCOUNT_INFO / ACCOUNT_TOKEN_RELATION(_FOREIGN) /
//     SIGNATURES_FOR_ADDRESS / TRANSACTION_DETAIL — identity, existence
//     and history. None bears on any component but its own.
//
// A DOCUMENT CAN NEVER TRAVEL THIS ROUTE. Applicability is keyed on
// `onchain_fact_kind`, which is null on every documentary, data-provider
// and model-extracted row, so the crossover is structurally unreachable
// for anything but a deterministic chain observation. Widening this map is
// an owner decision about research semantics, not an implementation
// liberty.
const APPLICABLE_COMPONENTS_BY_KIND: Partial<Record<OnchainFactKind, readonly string[]>> = {
  BURN: ["NET_EFFECT"],
};

// May a row of this kind, filed under some other component, be READ when
// reconciling `component`? False for a null kind, always — absence of a
// typed kind is absence of permission.
export function onchainFactAppliesToComponent(
  kind: string | null | undefined,
  component: string,
): boolean {
  if (kind === null || kind === undefined) return false;
  const applicable = APPLICABLE_COMPONENTS_BY_KIND[kind as OnchainFactKind];
  return applicable !== undefined && applicable.includes(component);
}

// Exposed for tests, so the map itself can be asserted rather than only
// its consequences.
export function applicableComponentsForFactKind(kind: OnchainFactKind): readonly string[] {
  return APPLICABLE_COMPONENTS_BY_KIND[kind] ?? [];
}

// THE SAME MAP, READ THE OTHER WAY: which typed kinds may a component READ
// from outside its own (step, component)?
//
// It exists because the map was only half-connected in production. The
// reconciler asked `onchainFactAppliesToComponent` per row, correctly — but
// the STORE that feeds it selected rows by (job, step, component) alone, so
// a BURN filed at EXECUTION_EVIDENCE was never among the rows NET_EFFECT
// was asked about. The rule was right and unreachable. A loader needs the
// question in this direction to build its query, and DERIVING it from
// `APPLICABLE_COMPONENTS_BY_KIND` rather than writing a second table is
// what keeps one authority: widening the map widens both directions at
// once, and the two can never disagree.
//
// Returns kinds only. It grants a loader permission to SELECT a row, never
// permission to admit it — `onchainFactAppliesToComponent` still decides
// that per row, and every ordinary guard still applies afterwards.
export function applicableFactKindsForComponent(component: string): readonly OnchainFactKind[] {
  const out: OnchainFactKind[] = [];
  for (const [kind, components] of Object.entries(APPLICABLE_COMPONENTS_BY_KIND)) {
    if (components?.includes(component)) out.push(kind as OnchainFactKind);
  }
  return out;
}

// A deterministic fact plus the kind it was synthesized as. Separate from
// ExtractedFact so the model's shape is untouched and cannot carry a kind.
export type SynthesizedFact = ExtractedFact & { onchainFactKind: OnchainFactKind };

// A fact is only worth synthesizing when the component it is offered for
// can actually be established by ONCHAIN_VERIFIABLE — that check belongs
// to the Pattern and is applied by the caller, not duplicated here.
export interface SynthesisTarget {
  step: number;
  component: string;
}

// `kind` is REQUIRED and positioned before the prose deliberately: every
// call site already knew which ONCHAIN_DOES_NOT_PROVE entry it was
// quoting, so the kind was always available and merely unrecorded. Making
// it a required parameter means a new fact cannot be added without
// declaring what it is.
function fact(
  target: SynthesisTarget,
  kind: OnchainFactKind,
  statement: string,
  supportFragment: string,
  doesNotProve: string,
  opts: { mechanismState?: string | null; relationship?: ExtractedFact["relationship"] } = {},
): SynthesizedFact {
  return {
    step: target.step,
    component: target.component,
    onchainFactKind: kind,
    statement,
    supportFragment,
    mechanismState: opts.mechanismState ?? null,
    // A direct read of canonical chain state is as direct as evidence gets.
    directness: "DIRECT",
    // Chain state carries no publication date; fetchedAt is the temporal
    // basis for ONCHAIN_VERIFIABLE, which S5 already handles.
    publishedAt: null,
    doesNotProve,
    relationship: opts.relationship ?? "SUPPORTS",
  };
}

// The literal excerpt a fact quotes. Always a slice of the artifact's own
// canonical JSON, so isTraceable-style checks hold by construction and a
// reader can see exactly which bytes the statement rests on.
function fragmentFor(artifact: OnchainArtifact, keys: string[]): string {
  const result = artifact.result as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of keys) if (k in result) picked[k] = result[k];
  return JSON.stringify(picked);
}

// Names the instructions an ownership reading rests on, in the plural when
// more than one agreed. Under-reporting agreement would make a stronger basis
// look like a weaker one.
function attestationBasis(types: readonly string[]): string {
  if (types.length === 0) return "by an instruction in the same transaction";
  if (types.length === 1) return `on the basis of a ${types[0]} instruction in the same transaction`;
  return `on the basis of ${types.join(" and ")} instructions in the same transaction`;
}

// Formats a raw integer amount with its decimals WITHOUT floating point —
// a token amount can exceed Number.MAX_SAFE_INTEGER, and rounding an
// on-chain quantity would corrupt the one thing this path exists to keep
// exact.
export function formatTokenAmount(amountRaw: string, decimals: number): string {
  if (!/^\d+$/.test(amountRaw)) return amountRaw;
  if (decimals <= 0) return amountRaw;
  const padded = amountRaw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

// Synthesizes every deterministic fact this artifact supports for the
// target component. Returns [] when the artifact carries nothing that
// bears on it — an empty result is a normal outcome and NEVER becomes a
// fact asserting absence.
export function synthesizeOnchainFacts(
  artifact: OnchainArtifact,
  target: SynthesisTarget,
): SynthesizedFact[] {
  const r = artifact.result;
  const slot = artifact.provenance.slot;

  switch (r.kind) {
    case "TOKEN_SUPPLY":
      return [
        fact(
          target,
          "TOKEN_SUPPLY",
          `On-chain total supply of token ${r.mint} is ${formatTokenAmount(r.amountRaw, r.decimals)} ` +
            `(raw ${r.amountRaw}, ${r.decimals} decimals) as observed at slot ${slot}.`,
          fragmentFor(artifact, ["mint", "amountRaw", "decimals"]),
          ONCHAIN_DOES_NOT_PROVE.TOKEN_SUPPLY,
        ),
      ];

    // TWO SEPARATE QUESTIONS, TWO SEPARATE FACTS.
    //
    // What the account IS (exists, owned by which program) has always been
    // stated. What RELATIONSHIP it has to this project's token was parsed
    // by the adapter and then went no further than the artifact, so the
    // Evidence layer could not see it.
    //
    // The relation fact is emitted ONLY when the node actually parsed a
    // mint. Program ownership alone says the account is a token account,
    // not which one — and "we could not tell which" is never written as a
    // relationship, in either direction.
    case "ACCOUNT_INFO": {
      if (!r.exists) return []; // absence is not a fact
      const facts: SynthesizedFact[] = [
        fact(
          target,
          "ACCOUNT_INFO",
          `Account ${r.address} exists on-chain and is owned by program ${r.ownerProgram ?? "unknown"} ` +
            `as observed at slot ${slot}.`,
          fragmentFor(artifact, ["address", "exists", "ownerProgram"]),
          ONCHAIN_DOES_NOT_PROVE.ACCOUNT_INFO,
        ),
      ];

      // NOT_TOKEN_PROGRAM_OWNED adds nothing here on purpose: the fact
      // above already names the exact owning program, which is the whole
      // of what was established. Restating it as "is not a token account"
      // would read as a classification of the address, and the next step
      // from there is calling it a wallet.
      //
      // TOKEN_PROGRAM_OWNED_UNRESOLVED adds nothing either, for the
      // opposite reason: something IS established (it is a token account)
      // but the mint is not, and there is no honest relationship sentence
      // that omits the mint without implying one.
      const parsed = r.tokenAccountRelation === "TOKEN_ACCOUNT_PARSED" ? r.tokenAccount : null;
      if (parsed !== null) {
        // The anchor comes from provenance — the project's confirmed
        // identity — and the mint from the observation. They are compared,
        // never conflated, and the subject is a third address again.
        const anchor = artifact.provenance.projectAnchor;
        const isAnchorMint = parsed.mint === anchor;
        const ownerClause = parsed.owner === null ? "" : ` with token-account owner ${parsed.owner}`;
        facts.push(
          fact(
            target,
            isAnchorMint ? "ACCOUNT_TOKEN_RELATION" : "ACCOUNT_TOKEN_RELATION_FOREIGN",
            isAnchorMint
              ? `Account ${r.address} is an SPL token account for mint ${parsed.mint}, this project's ` +
                  `confirmed mint, held under program ${r.ownerProgram ?? "unknown"}${ownerClause}, ` +
                  `as observed at slot ${slot}.`
              : `Account ${r.address} is an SPL token account for mint ${parsed.mint}, which is NOT this ` +
                  `project's confirmed mint ${anchor}, held under program ${r.ownerProgram ?? "unknown"}` +
                  `${ownerClause}, as observed at slot ${slot}.`,
            fragmentFor(artifact, ["address", "tokenAccountRelation", "tokenAccount"]),
            isAnchorMint
              ? ONCHAIN_DOES_NOT_PROVE.ACCOUNT_TOKEN_RELATION
              : ONCHAIN_DOES_NOT_PROVE.ACCOUNT_TOKEN_RELATION_FOREIGN,
            // A foreign-mint account is not evidence FOR anything about
            // this project. It is context that bounds what the documentary
            // mention of the address can mean — never support.
            isAnchorMint ? {} : { relationship: "CONTEXT" },
          ),
        );
      }
      return facts;
    }

    case "TOKEN_ACCOUNT_BALANCE":
      return [
        fact(
          target,
          "TOKEN_ACCOUNT_BALANCE",
          `Token account ${r.account} holds ${formatTokenAmount(r.amountRaw, r.decimals)} ` +
            `(raw ${r.amountRaw}, ${r.decimals} decimals) as observed at slot ${slot}.`,
          fragmentFor(artifact, ["account", "amountRaw", "decimals"]),
          ONCHAIN_DOES_NOT_PROVE.TOKEN_ACCOUNT_BALANCE,
        ),
      ];

    case "TOKEN_ACCOUNTS_BY_OWNER": {
      // Absence is not a fact: an address owning no token account for
      // this mint yields nothing, never a claim that it owns none.
      if (r.accounts.length === 0) return [];
      // ONE fact per token account. They are independent positions and
      // collapsing them into a total would invent an aggregate the
      // chain never reported.
      return r.accounts.map((a, index) =>
        fact(
          target,
          "TOKEN_ACCOUNTS_BY_OWNER",
          `Address ${r.owner} owns SPL token account ${a.account} for mint ${r.mint} with balance ` +
            `${formatTokenAmount(a.amountRaw, a.decimals)} (raw ${a.amountRaw}, ${a.decimals} decimals) ` +
            `as observed at slot ${slot}.`,
          // A PER-ACCOUNT fragment, not the whole result: two accounts of
          // the same owner must not quote identical bytes, or they would
          // deduplicate into one fact downstream.
          JSON.stringify({ owner: r.owner, mint: r.mint, account: r.accounts[index] }),
          ONCHAIN_DOES_NOT_PROVE.TOKEN_ACCOUNTS_BY_OWNER,
          { relationship: "CONTEXT" },
        ),
      );
    }

    case "SIGNATURES_FOR_ADDRESS":
      if (r.signatures.length === 0) return []; // absence is not a fact
      return [
        fact(
          target,
          "SIGNATURES_FOR_ADDRESS",
          `Address ${r.address} has ${r.signatures.length} on-chain transaction(s) in the observed window, ` +
            `most recent at slot ${r.signatures[0].slot}.`,
          fragmentFor(artifact, ["address", "signatures"]),
          ONCHAIN_DOES_NOT_PROVE.SIGNATURES_FOR_ADDRESS,
          { relationship: "CONTEXT" },
        ),
      ];

    case "TRANSACTION_DETAIL": {
      // A failed transaction executed nothing.
      if (!r.succeeded) return [];
      const facts: SynthesizedFact[] = [];

      // ONE artifact, MULTIPLE facts — the provenance model exists
      // precisely so several burn instructions in one transaction share a
      // single stored retrieval.
      for (const [index, b] of r.burns.entries()) {
        facts.push(
          fact(
            target,
            "BURN",
            `Transaction ${r.signature} (slot ${r.slot}) executed an SPL Token ${b.instructionType} instruction ` +
              `destroying ${b.decimals === null ? b.amountRaw : formatTokenAmount(b.amountRaw, b.decimals)} ` +
              `of mint ${b.mint} from token account ${b.sourceAccount}.`,
            JSON.stringify({ signature: r.signature, slot: r.slot, burn: r.burns[index] }),
            ONCHAIN_DOES_NOT_PROVE.BURN,
            // A confirmed on-chain execution is the mechanism running, which
            // is what EXECUTION_EVIDENCE's live-state gate asks for.
            { mechanismState: "LIVE" },
          ),
        );
      }

      // RECIPROCAL ASSET FLOW. A transaction can carry two assets moving
      // opposite ways between the same two parties, and until now that
      // produced NOTHING: this case synthesized burns and only burns, so a
      // transaction with no burn yielded no fact at all however much it
      // deterministically established.
      //
      // Each derived flow yields THREE facts, kept separate on purpose.
      // The two legs are direct decoded movements; the pairing is a
      // structural composition of them. All three are offered as CONTEXT.
      //
      // WHY A TRUE, DIRECT, PROJECT-BOUND MOVEMENT STILL DOES NOT SUPPORT.
      // The legs were previously SUPPORTS on the reasoning that a decoded
      // transfer is as direct as chain evidence gets. That is true about
      // the transfer and says nothing about the COMPONENT. Every Pattern v1
      // component a transfer can be offered for asks a mechanism-level or
      // economic question, never a bare routing one: FLOW_PATH traces the
      // hops THE VALUE takes through the protocol, DESTINATION asks where
      // assets end up AFTER THE MECHANISM EXECUTES and whether that
      // destination retains, redistributes or retires them, and RECIPIENT
      // asks who ULTIMATELY RECEIVES THE ECONOMIC BENEFIT. A transfer
      // establishes that an amount moved between two accounts whose owners
      // the RPC reported. It does not establish that the movement belongs
      // to the claimed mechanism, that either endpoint is the mechanism's
      // destination rather than an intermediate or unrelated hop, or that a
      // token-account owner is the party that ends up better off — the
      // three things those components actually ask for.
      //
      // A transaction-level destination is not a mechanism-level
      // destination, and a token-account owner is not an economic
      // recipient. Offered as SUPPORTS, one unrelated transfer of the
      // project's token would flip its component to SUPPORTED on its own,
      // because S5 reconciles one component from one pool and never waits
      // for the binding to arrive from anywhere else.
      //
      // CONTEXT is the honest label, and the same one an observed balance
      // and an observed signature window already carry here: real, bounded,
      // recorded, inert until something else binds it. Not INDIRECT —
      // directness grades how directly evidence bears on ITS proposition,
      // and this bears on a different proposition. The bridge from movement
      // to mechanism is separate admitted evidence, exactly as it is for a
      // genuine burn.
      for (const flow of deriveReciprocalAssetFlows(r, artifact.provenance.projectAnchor)) {
        const legFragment = (leg: unknown, role: string) =>
          JSON.stringify({ signature: r.signature, slot: r.slot, role, leg });

        // TWO SENTENCES FOR TWO SHAPES, because one sentence cannot be true of
        // both. Direct: the lamports landed in an account the other party owns.
        // Routed: they landed in an account the SENDER owns, and a further hop
        // reached the other party — calling that destination the
        // counterparty's would be false, and carrying the arriving amount
        // across the hop would be a second falsehood on top of it.
        const via = flow.outbound.via;
        const syncedClause = flow.outbound.destinationSyncedNative
          ? ", and a syncNative instruction on that account was observed in the same transaction"
          : "";
        facts.push(
          fact(
            target,
            "NATIVE_TRANSFER",
            via === undefined
              ? `Transaction ${flow.signature} (slot ${flow.slot}) transferred ${flow.outbound.amountRaw} lamports ` +
                  `of native SOL from address ${flow.participant} to token account ${flow.outbound.to}, which the ` +
                  `transaction's balance metadata reports as owned by ${flow.counterparty}${syncedClause}.`
              : `Transaction ${flow.signature} (slot ${flow.slot}) transferred ${flow.outbound.amountRaw} lamports ` +
                  `of native SOL from address ${flow.participant} to token account ${via.account}, reported as owned ` +
                  `by ${via.accountOwner} — the sending address itself — ` +
                  `${via.ownerSource === "LIFECYCLE_ATTESTATION" ? attestationBasis(via.attestedBy) : "by the transaction's balance metadata"}` +
                  `${syncedClause}. That account transferred ` +
                  `${via.onward.mint === null ? via.onward.amountRaw : `${via.onward.amountRaw} of mint ${via.onward.mint}`} ` +
                  `into token account ${via.onward.to}, owned by ${flow.counterparty}` +
                  `${via.closedInTransaction ? ", and was closed in the same transaction" : ""}.`,
            legFragment(flow.outbound, "outbound"),
            ONCHAIN_DOES_NOT_PROVE.NATIVE_TRANSFER,
            { relationship: "CONTEXT" },
          ),
        );

        facts.push(
          fact(
            target,
            "TOKEN_TRANSFER",
            `Transaction ${flow.signature} (slot ${flow.slot}) transferred ` +
              `${flow.inbound.decimals === null ? flow.inbound.amountRaw : formatTokenAmount(flow.inbound.amountRaw, flow.inbound.decimals)} ` +
              `of mint ${flow.inbound.mint} from token account ${flow.inbound.from}, owned by ${flow.counterparty}, ` +
              `into token account ${flow.inbound.to}, owned by ${flow.participant}.`,
            legFragment(flow.inbound, "inbound"),
            ONCHAIN_DOES_NOT_PROVE.TOKEN_TRANSFER,
            { relationship: "CONTEXT" },
          ),
        );

        facts.push(
          fact(
            target,
            "RECIPROCAL_ASSET_FLOW",
            `The same successful transaction ${flow.signature} (slot ${flow.slot}) contains both movements: ` +
              `native SOL from ${flow.participant} ` +
              `${via === undefined ? "toward an account owned by" : "into an account it owns itself, from which a further transfer reached an account owned by"} ` +
              `${flow.counterparty}, and mint ${flow.inbound.mint} from an account owned by ${flow.counterparty} ` +
              `into an account owned by ${flow.participant}.`,
            JSON.stringify({
              signature: r.signature,
              slot: r.slot,
              participant: flow.participant,
              counterparty: flow.counterparty,
              outbound: flow.outbound,
              inbound: flow.inbound,
            }),
            RECIPROCAL_FLOW_DOES_NOT_PROVE,
            // Structural co-occurrence, not an established exchange. CONTEXT
            // is inert in reconciliation, so this can never push a component
            // toward SUPPORTED by resembling a purchase. Unchanged: this
            // fact was never anything else.
            { relationship: "CONTEXT" },
          ),
        );
      }

      // A DECODED EXCHANGE, WHEN THE INSTRUCTION ITSELF SAYS SO.
      //
      // The reciprocal facts above stay exactly as they are: they describe
      // movement and are offered as CONTEXT because movement is not a
      // mechanism. This one is different in what it reads — the venue
      // instruction's own method name, and an event the program emitted
      // stating both assets and both amounts — and identical in what it
      // may conclude. An exchange is an economic fact about two parties;
      // it is still not evidence that any published mechanism was being
      // carried out, so it remains CONTEXT and establishes no component.
      const exchange = deriveDecodedExchange(r, artifact.provenance.projectAnchor);
      if (exchange !== null) {
        facts.push(
          fact(
            target,
            "DECODED_EXCHANGE",
            `Transaction ${exchange.signature} (slot ${exchange.slot}) deterministically executes an asset ` +
              `exchange within outer instruction ${exchange.invocationIndex}: address ${exchange.participant} ` +
              `paid ${exchange.paid.amountRaw} raw units of mint ${exchange.paid.mint} from token account ` +
              `${exchange.paid.fromAccount} into token account ${exchange.paid.toAccount}, owned by ` +
              `${exchange.counterparty}, and received ${exchange.received.amountRaw} raw units of mint ` +
              `${exchange.received.mint} from token account ${exchange.received.fromAccount}, owned by ` +
              `${exchange.counterparty}, into token account ${exchange.received.toAccount}. The venue ` +
              `instruction's own method is ${exchange.basis.venueMethod}, and an event emitted by program ` +
              `${exchange.basis.eventProgramId} in the same invocation states both assets and both amounts.`,
            JSON.stringify({ signature: r.signature, slot: r.slot, exchange }),
            EXCHANGE_DOES_NOT_PROVE,
            { relationship: "CONTEXT" },
          ),
        );
      }

      return facts;
    }

  }
}
