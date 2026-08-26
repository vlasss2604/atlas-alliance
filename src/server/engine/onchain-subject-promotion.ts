import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainIntentKind,
} from "./providers/onchain-types";

// BOUNDED SUBJECT PROMOTION — one confirmed observation may earn ONE next
// research step.
//
// The owner scripts proved a real research path by hand: a documented
// account leads to the token accounts it owns, a token account leads to
// one bounded window of its signatures, one signature leads to one
// transaction, and the transaction either contains a burn or does not.
// Every hop in that chain was a human typing the next subject on a command
// line. This module is that reasoning, written down.
//
// IT IS NOT AN AGENT. There is no recursion, no search, no goal and no
// retry. It is a pure function from ONE artifact to AT MOST a small list of
// next intents, driven by a caller's loop that carries a depth counter and
// a hard ceiling. Given the same artifact it returns the same intents, and
// given an artifact it has no rule for it returns nothing.
//
// IT CANNOT SEEK AN OUTCOME. Nothing here inspects whether a burn was
// found, whether a claim is closer to supported, or whether the research
// is "going well". A transaction that contains no burn promotes exactly
// what a transaction containing one promotes: nothing. Ending empty-handed
// is a result, and INSUFFICIENT_EVIDENCE is a valid one.
//
// NO PAGINATION, EVER. The one rule that could page — signatures — reads a
// single window and then promotes a transaction, not another window. There
// is no cursor field anywhere in this file, and a test asserts the words
// are absent from the source.
//
// NO COUNTERPARTY CHASING. A transaction names many accounts: senders,
// pools, fee recipients, programs. None of them is promoted. The only
// addresses that ever become subjects are ones the project's OWN
// documented account or its own token accounts led to.

// The deepest chain V1 permits:
//
//   depth 0  documentary locator (or the project anchor)
//   depth 1  token account owned by it
//   depth 2  a signature observed on that token account
//   depth 3  the transaction behind that signature   <- terminal
//
// Four levels, and the fourth promotes nothing. A rule that wanted depth 4
// would have to be written, reviewed and given a reason.
export const MAX_PROMOTION_DEPTH = 3;

// How many promoted operations one attempt may perform, over and above the
// base intents. NOT a budget: every promoted call still reserves its own
// sourceOpen against the job's existing ceiling and is refused when the
// ceiling is reached. This is a second, stricter bound so that a job with
// a generous budget still cannot spend it all on one component's chain.
export const MAX_PROMOTED_INTENTS_PER_ATTEMPT = 3;

export type PromotionRule =
  | "ACCOUNT_TO_TOKEN_ACCOUNTS"
  | "TOKEN_ACCOUNT_TO_SIGNATURES"
  | "SIGNATURE_TO_TRANSACTION";

export interface PromotedSubject {
  subject: string;
  subjectKind: OnchainIntent["subjectKind"];
  intentKind: OnchainIntentKind;
  // The observation this came out of. A promoted subject without a parent
  // is unrepresentable.
  parentSubject: string;
  chain: string;
  network: string;
  projectAnchor: string;
  depth: number;
  rule: PromotionRule;
  // Which component's research justified the step. Promotion is never
  // "because we could" — it is always for a component that needs it.
  originComponent: string;
}

// The intents a promoted subject may be used for, keyed by the rule that
// produced it. Pure data: a rule cannot smuggle in an intent kind that is
// not written here.
const INTENT_FOR_RULE: Record<PromotionRule, OnchainIntentKind> = {
  ACCOUNT_TO_TOKEN_ACCOUNTS: "TOKEN_ACCOUNTS_BY_OWNER",
  TOKEN_ACCOUNT_TO_SIGNATURES: "SIGNATURES_FOR_ADDRESS",
  SIGNATURE_TO_TRANSACTION: "TRANSACTION_DETAIL",
};

// Which components may follow which rule, and why.
//
// DESTINATION / RECIPIENT ask where value LANDS, so discovering the token
// accounts a documented account owns is directly on-topic; a wallet that
// holds no token account for the project's mint is itself an answer.
//
// EXECUTION_EVIDENCE asks whether a mechanism actually RAN, which is the
// only question a transaction can answer — so it is the only component
// permitted to reach a signature window or a transaction. Every other
// component stops at discovery.
const RULES_BY_COMPONENT: Record<string, readonly PromotionRule[]> = {
  DESTINATION: ["ACCOUNT_TO_TOKEN_ACCOUNTS"],
  RECIPIENT: ["ACCOUNT_TO_TOKEN_ACCOUNTS"],
  EXECUTION_EVIDENCE: [
    "ACCOUNT_TO_TOKEN_ACCOUNTS",
    "TOKEN_ACCOUNT_TO_SIGNATURES",
    "SIGNATURE_TO_TRANSACTION",
  ],
};

export function componentAllowsRule(component: string, rule: PromotionRule): boolean {
  return (RULES_BY_COMPONENT[component] ?? []).includes(rule);
}

// Intent kinds that may ONLY be reached by promotion. A transaction cannot
// be a base intent because a base subject is an address and a transaction
// subject is a signature — there is nowhere for one to come from except an
// observation that produced it.
export const PROMOTION_ONLY_INTENTS: ReadonlySet<OnchainIntentKind> = new Set([
  "TRANSACTION_DETAIL",
]);

export interface PromotionInput {
  artifact: OnchainArtifact;
  // The entity-binding outcome for that artifact. An unbound observation
  // promotes nothing — a read that is not confirmed to be ABOUT this
  // project cannot hand this project a new subject.
  bindingConfirmed: boolean;
  // Depth of the observation being promoted FROM. The children are at
  // depth + 1.
  depth: number;
  component: string;
  // Subjects already visited in this attempt, so a chain cannot revisit
  // its own parent or loop between two accounts.
  visited: ReadonlySet<string>;
}

export type PromotionRefusal =
  | "BINDING_NOT_CONFIRMED"
  | "DEPTH_LIMIT"
  | "TERMINAL_OBSERVATION"
  | "NO_ELIGIBLE_SUBJECT"
  | "COMPONENT_NOT_PERMITTED";

export interface PromotionOutcome {
  promoted: PromotedSubject[];
  // Why nothing was promoted. Present only when `promoted` is empty, and
  // never a failure — most refusals are the system working.
  refusal: PromotionRefusal | null;
}

// DETERMINISTIC SIGNATURE SELECTION.
//
// Exactly one signature from a window, chosen by a rule that cannot be
// steered: the most recent SUCCESSFUL one, ties broken by comparing the
// signature strings. A failed transaction is skipped because it changed
// nothing on chain, not because it is inconvenient.
//
// The memo is deliberately NOT consulted. A memo is arbitrary text the
// sender chose, and selecting by it would let anyone who can write a memo
// decide what ATLAS reads.
function selectOneSignature(
  signatures: readonly { signature: string; slot: number; err: boolean }[],
): string | null {
  let best: { signature: string; slot: number } | null = null;
  for (const s of signatures) {
    if (s.err) continue;
    if (
      best === null ||
      s.slot > best.slot ||
      (s.slot === best.slot && s.signature < best.signature)
    ) {
      best = { signature: s.signature, slot: s.slot };
    }
  }
  return best?.signature ?? null;
}

// The one rule per observation kind. Returns the subjects a confirmed
// observation earns, or a refusal saying why it earned none.
export function promoteFromObservation(input: PromotionInput): PromotionOutcome {
  const none = (refusal: PromotionRefusal): PromotionOutcome => ({ promoted: [], refusal });

  if (!input.bindingConfirmed) return none("BINDING_NOT_CONFIRMED");
  if (input.depth >= MAX_PROMOTION_DEPTH) return none("DEPTH_LIMIT");

  const result = input.artifact.result;
  const p = input.artifact.provenance;
  const childDepth = input.depth + 1;

  const build = (
    subject: string,
    rule: PromotionRule,
    parentSubject: string,
  ): PromotedSubject => ({
    subject,
    intentKind: INTENT_FOR_RULE[rule],
    subjectKind: INTENT_FOR_RULE[rule] === "TRANSACTION_DETAIL" ? "tx" : "account",
    parentSubject,
    chain: p.chain,
    network: p.network,
    projectAnchor: p.projectAnchor,
    depth: childDepth,
    rule,
    originComponent: input.component,
  });

  switch (result.kind) {
    // An account that EXISTS may own token accounts for the project's
    // mint. Asking is one bounded call and the answer is useful either
    // way — an account owning none is a finding, not a dead end.
    //
    // The account's owner PROGRAM is deliberately not consulted. Reading
    // it would mean hard-coding the System program id into research
    // logic, and the question "which of our token accounts does this
    // address own?" is well-formed for any account that exists.
    case "ACCOUNT_INFO": {
      if (!componentAllowsRule(input.component, "ACCOUNT_TO_TOKEN_ACCOUNTS")) {
        return none("COMPONENT_NOT_PERMITTED");
      }
      if (!result.exists) return none("NO_ELIGIBLE_SUBJECT");
      if (input.visited.has(`TOKEN_ACCOUNTS_BY_OWNER::${result.address}`)) {
        return none("NO_ELIGIBLE_SUBJECT");
      }
      return {
        promoted: [build(result.address, "ACCOUNT_TO_TOKEN_ACCOUNTS", result.address)],
        refusal: null,
      };
    }

    // Each returned token account is a real subject with real provenance.
    // The owner and mint are re-checked against the query's own answer, so
    // an adapter that ever returned a foreign account could not launder it
    // into a subject here.
    case "TOKEN_ACCOUNTS_BY_OWNER": {
      if (!componentAllowsRule(input.component, "TOKEN_ACCOUNT_TO_SIGNATURES")) {
        return none("COMPONENT_NOT_PERMITTED");
      }
      const eligible = result.accounts
        .filter((a) => a.owner === result.owner && a.mint === result.mint)
        .map((a) => a.account)
        .filter((a) => !input.visited.has(`SIGNATURES_FOR_ADDRESS::${a}`))
        .sort();
      if (eligible.length === 0) return none("NO_ELIGIBLE_SUBJECT");
      // ONE account per observation. A wallet holding several token
      // accounts for one mint does not license several signature windows.
      return {
        promoted: [build(eligible[0], "TOKEN_ACCOUNT_TO_SIGNATURES", result.owner)],
        refusal: null,
      };
    }

    // ONE window in, ONE transaction out. Never another window.
    case "SIGNATURES_FOR_ADDRESS": {
      if (!componentAllowsRule(input.component, "SIGNATURE_TO_TRANSACTION")) {
        return none("COMPONENT_NOT_PERMITTED");
      }
      const chosen = selectOneSignature(result.signatures);
      if (chosen === null) return none("NO_ELIGIBLE_SUBJECT");
      if (input.visited.has(`TRANSACTION_DETAIL::${chosen}`)) return none("NO_ELIGIBLE_SUBJECT");
      return {
        promoted: [build(chosen, "SIGNATURE_TO_TRANSACTION", result.address)],
        refusal: null,
      };
    }

    // TERMINAL. A transaction is where a chain ends, whether or not it
    // contained what anyone hoped for. Promoting from here is what
    // "keep looking until you find a burn" would look like in code, and
    // it is not written.
    case "TRANSACTION_DETAIL":
      return none("TERMINAL_OBSERVATION");

    default:
      return none("TERMINAL_OBSERVATION");
  }
}

// The intent a promoted subject turns into. Separated from the rule so a
// caller cannot construct an intent for a promoted subject by hand.
export function intentForPromotedSubject(s: PromotedSubject): OnchainIntent {
  return {
    kind: s.intentKind,
    chain: s.chain as OnchainIntent["chain"],
    network: s.network as OnchainIntent["network"],
    projectAnchor: s.projectAnchor,
    subjectKind: s.subjectKind,
    subject: s.subject,
  };
}
