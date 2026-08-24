import type { ExtractedFact } from "./providers/types";
import type { OnchainArtifact } from "./providers/onchain-types";

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
  TOKEN_ACCOUNT_BALANCE:
    "This is the token balance held by the account at the observed slot. It does not establish how the balance " +
    "arrived there, who controls the account, whether the holding is permanent, or what the holding means " +
    "economically for token holders.",
  SIGNATURES_FOR_ADDRESS:
    "These are transactions involving the address at the observed slot range. It does not establish what any of " +
    "them did, that they relate to any particular mechanism, or that the list is complete beyond the queried " +
    "window.",
  TOKEN_ACCOUNTS_BY_OWNER:
    "This shows which SPL token accounts the queried wallet holds for the queried mint, and their balances, at " +
    "the observed slot. It does not establish how any balance got there, who funded it, who controls the " +
    "wallet beyond the owner field the RPC reports, what role the wallet plays in any mechanism, that any " +
    "token was burned or bought back, or that circulating or total supply changed. A balance is a position at " +
    "a moment, never a history and never a purpose.",
  TRANSACTION_DETAIL:
    "This is the on-chain content of one transaction. It does not establish the economic purpose of the " +
    "transaction, who funded it, or that it belongs to any particular mechanism or policy.",
  // Owner-specified verbatim requirements for the burn fact.
  BURN:
    "This is a genuine SPL Token burn instruction executed on-chain: the stated amount of the stated mint was " +
    "destroyed from the stated token account. It does NOT prove who economically funded the purchase of those " +
    "tokens; it does NOT prove the burned tokens came from a buyback; it does NOT prove that a broader buyback " +
    "policy exists; and it does NOT establish circulating-supply semantics beyond the observed on-chain effect. " +
    "Linking this burn to a buyback mechanism requires separate admitted evidence.",
} as const;

// A fact is only worth synthesizing when the component it is offered for
// can actually be established by ONCHAIN_VERIFIABLE — that check belongs
// to the Pattern and is applied by the caller, not duplicated here.
export interface SynthesisTarget {
  step: number;
  component: string;
}

function fact(
  target: SynthesisTarget,
  statement: string,
  supportFragment: string,
  doesNotProve: string,
  opts: { mechanismState?: string | null; relationship?: ExtractedFact["relationship"] } = {},
): ExtractedFact {
  return {
    step: target.step,
    component: target.component,
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
): ExtractedFact[] {
  const r = artifact.result;
  const slot = artifact.provenance.slot;

  switch (r.kind) {
    case "TOKEN_SUPPLY":
      return [
        fact(
          target,
          `On-chain total supply of token ${r.mint} is ${formatTokenAmount(r.amountRaw, r.decimals)} ` +
            `(raw ${r.amountRaw}, ${r.decimals} decimals) as observed at slot ${slot}.`,
          fragmentFor(artifact, ["mint", "amountRaw", "decimals"]),
          ONCHAIN_DOES_NOT_PROVE.TOKEN_SUPPLY,
        ),
      ];

    case "ACCOUNT_INFO":
      if (!r.exists) return []; // absence is not a fact
      return [
        fact(
          target,
          `Account ${r.address} exists on-chain and is owned by program ${r.ownerProgram ?? "unknown"} ` +
            `as observed at slot ${slot}.`,
          fragmentFor(artifact, ["address", "exists", "ownerProgram"]),
          ONCHAIN_DOES_NOT_PROVE.ACCOUNT_INFO,
        ),
      ];

    case "TOKEN_ACCOUNT_BALANCE":
      return [
        fact(
          target,
          `Token account ${r.account} holds ${formatTokenAmount(r.amountRaw, r.decimals)} ` +
            `(raw ${r.amountRaw}, ${r.decimals} decimals) as observed at slot ${slot}.`,
          fragmentFor(artifact, ["account", "amountRaw", "decimals"]),
          ONCHAIN_DOES_NOT_PROVE.TOKEN_ACCOUNT_BALANCE,
        ),
      ];

    case "TOKEN_ACCOUNTS_BY_OWNER": {
      // Absence is not a fact: a wallet holding no token account for
      // this mint yields nothing, never a claim that it holds none.
      if (r.accounts.length === 0) return [];
      // ONE fact per token account. They are independent positions and
      // collapsing them into a total would invent an aggregate the
      // chain never reported.
      return r.accounts.map((a, index) =>
        fact(
          target,
          `Wallet ${r.owner} holds SPL token account ${a.account} for mint ${r.mint} with balance ` +
            `${formatTokenAmount(a.amountRaw, a.decimals)} (raw ${a.amountRaw}, ${a.decimals} decimals) ` +
            `as observed at slot ${slot}.`,
          // A PER-ACCOUNT fragment, not the whole result: two accounts of
          // the same wallet must not quote identical bytes, or they would
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
      // ONE artifact, MULTIPLE facts — the provenance model exists
      // precisely so several burn instructions in one transaction share a
      // single stored retrieval.
      return r.burns.map((b, index) =>
        fact(
          target,
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
  }
}
