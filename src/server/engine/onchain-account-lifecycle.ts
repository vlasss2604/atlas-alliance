import type {
  AccountLifecycleRef,
  TransactionDetailResult,
} from "./providers/onchain-types";

// WHAT ONE TOKEN ACCOUNT WAS, WITHIN ONE TRANSACTION.
//
// Built because an ephemeral wrapped-SOL account — created, spent through
// and closed inside a single transaction — appears in no balance list at
// all, and the only surviving trace of it was a set of instructions whose
// `authority` field names a signer, not an owner. Reading that signer as
// the owner is a guess dressed as a fact, and this module exists so the
// guess has no place to live.
//
// OWNERSHIP HAS EXACTLY TWO SOURCES, both protocol-definitional:
//
//   * initializeAccount / initializeAccount2 / initializeAccount3 — the
//     `owner` field IS the token account's owner, by definition of the
//     instruction;
//   * Associated Token Account create / createIdempotent — the `wallet`
//     field IS the owner the ATA is derived for.
//
// Nothing else establishes it. A transfer authority may be a delegate. A
// close authority may be a designated close authority. A close destination
// merely receives lamports. A payer merely funded rent. Each of those is
// carried on its own field, and none of them can reach `owner`.
//
// UNKNOWN IS A REAL ANSWER AND THE DEFAULT ONE. A transaction that never
// initialized the account yields UNKNOWN ownership no matter how many
// instructions the wallet signed within it.
//
// NO IS NOT AN ANSWER THIS CAN GIVE. There is no "this account was not
// created" outcome, because absence of a creation instruction is absence
// of evidence, not evidence of absence — the account may simply have
// existed beforehand. Every determination is therefore YES or UNKNOWN.
//
// IT NAMES NO ECONOMIC ROLE. Account lifecycle is plumbing. Whether an
// account is a treasury, a burn address, a vault or a user's wallet is not
// visible here and never becomes so.

export type LifecycleAnswer = "YES" | "UNKNOWN";

// Where a determination came from. Present on every field so a reader
// never has to ask whether a value was decoded or assumed — nothing here
// is ever assumed, and the basis says so explicitly.
export type EvidenceBasis = "DECODED_FROM_INSTRUCTION" | "UNKNOWN";

export interface Determination<T> {
  value: T;
  basis: EvidenceBasis;
  // The instruction type that established it, when one did.
  fromInstruction: string | null;
}

export interface AccountLifecycle {
  account: string;
  created: Determination<LifecycleAnswer>;
  initialized: Determination<LifecycleAnswer>;
  tokenProgram: Determination<string | null>;
  mint: Determination<string | null>;
  // The token account's owner. UNKNOWN unless an initialization or an ATA
  // creation named it in this transaction.
  owner: Determination<string | null>;
  syncNative: Determination<LifecycleAnswer>;
  closed: Determination<LifecycleAnswer>;
  closeDestination: Determination<string | null>;
  // Who funded creation. Recorded because it is a real fact, and kept
  // apart because paying for an account is not owning it.
  payer: Determination<string | null>;
}

export const ACCOUNT_LIFECYCLE_DOES_NOT_PROVE =
  "This reconstructs what a transaction's own instructions say about how one token account " +
  "was created, initialized, synced or closed. It does not establish what the account is for, " +
  "who benefits from it, what any balance in it represented, or that the transaction " +
  "accomplished any economic purpose. An UNKNOWN field means this transaction did not say — " +
  "never that the thing did not happen.";

const UNKNOWN_ANSWER: Determination<LifecycleAnswer> = {
  value: "UNKNOWN",
  basis: "UNKNOWN",
  fromInstruction: null,
};

const UNKNOWN_VALUE: Determination<string | null> = {
  value: null,
  basis: "UNKNOWN",
  fromInstruction: null,
};

const CREATION_TYPES = new Set([
  "createAccount",
  "createAccountWithSeed",
  "create",
  "createIdempotent",
]);

// The two instruction families whose owner field is definitional. Mirrors
// the adapter's own gate: an instruction type reaches ownership here only
// if the decoder was willing to populate `owner` for it in the first place,
// so both layers must agree before an owner can be stated.
const OWNER_ESTABLISHING_TYPES = new Set([
  "initializeAccount",
  "initializeAccount2",
  "initializeAccount3",
  "create",
  "createIdempotent",
]);

const INITIALIZATION_TYPES = new Set([
  "initializeAccount",
  "initializeAccount2",
  "initializeAccount3",
]);

function decoded<T>(value: T, fromInstruction: string): Determination<T> {
  return { value, basis: "DECODED_FROM_INSTRUCTION", fromInstruction };
}

// Reconstructs one account's lifecycle from a transaction's decoded
// instructions.
//
// The account is a parameter and is matched exactly. Instructions naming
// any other account are not this account's business and cannot contribute
// a single field — the whole point of a transaction-local reconstruction
// is that a busy transaction touching twenty accounts yields twenty
// separate, non-overlapping answers.
export function reconstructAccountLifecycle(
  result: TransactionDetailResult,
  account: string,
): AccountLifecycle {
  const mine: AccountLifecycleRef[] = result.lifecycleInstructions.filter(
    (i) => i.account === account,
  );

  const lifecycle: AccountLifecycle = {
    account,
    created: UNKNOWN_ANSWER,
    initialized: UNKNOWN_ANSWER,
    tokenProgram: UNKNOWN_VALUE,
    mint: UNKNOWN_VALUE,
    owner: UNKNOWN_VALUE,
    syncNative: UNKNOWN_ANSWER,
    closed: UNKNOWN_ANSWER,
    closeDestination: UNKNOWN_VALUE,
    payer: UNKNOWN_VALUE,
  };

  // Ownership claims are collected before being accepted. One account
  // initialized twice with two different owners is a contradiction, and a
  // contradiction resolves to UNKNOWN rather than to whichever came first.
  const ownerClaims = new Map<string, string>();

  for (const ix of mine) {
    if (CREATION_TYPES.has(ix.type)) {
      lifecycle.created = decoded("YES", ix.type);
      if (ix.payer !== null) lifecycle.payer = decoded(ix.payer, ix.type);
      // A System creation assigns the account to a program. That program
      // is NOT the token program of an initialized token account until an
      // initialization says so, but for an ATA creation the instruction
      // names the token program outright.
      if (ix.tokenProgram !== null) {
        lifecycle.tokenProgram = decoded(ix.tokenProgram, ix.type);
      }
    }

    if (INITIALIZATION_TYPES.has(ix.type)) {
      lifecycle.initialized = decoded("YES", ix.type);
      // The initializing program IS the token program of the account.
      lifecycle.tokenProgram = decoded(ix.programId, ix.type);
    }

    if (ix.mint !== null && lifecycle.mint.basis === "UNKNOWN") {
      lifecycle.mint = decoded(ix.mint, ix.type);
    }

    if (OWNER_ESTABLISHING_TYPES.has(ix.type) && ix.owner !== null) {
      ownerClaims.set(ix.owner, ix.type);
    }

    if (ix.type === "syncNative") {
      lifecycle.syncNative = decoded("YES", ix.type);
    }
  }

  if (ownerClaims.size === 1) {
    const [[owner, from]] = [...ownerClaims.entries()];
    lifecycle.owner = decoded(owner, from);
  }
  // size 0 → never stated. size > 1 → contradictory. Both stay UNKNOWN.

  // Closure lives on the movement type rather than the lifecycle type,
  // because closeAccount is an SPL Token instruction the adapter already
  // decoded. Its `authority` is deliberately NOT consulted: whoever may
  // close an account is not thereby its owner.
  for (const ix of result.tokenInstructions) {
    if (ix.type !== "closeAccount" || ix.account !== account) continue;
    lifecycle.closed = decoded("YES", ix.type);
    if (ix.destination !== null) {
      lifecycle.closeDestination = decoded(ix.destination, ix.type);
    }
  }

  return lifecycle;
}

// True only when this transaction's own instructions establish that the
// named wallet owns the account. Deliberately a narrow predicate rather
// than a score: there is no "probably owns".
export function ownsAccountInTransaction(
  result: TransactionDetailResult,
  account: string,
  wallet: string,
): boolean {
  const lifecycle = reconstructAccountLifecycle(result, account);
  return (
    lifecycle.owner.basis === "DECODED_FROM_INSTRUCTION" && lifecycle.owner.value === wallet
  );
}
