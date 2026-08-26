// Structured on-chain retrieval — shared types (owner-approved V1).
//
// ONCHAIN_VERIFIABLE is an EVIDENCE CLASS, never a website, a provider, or
// a transport. This module defines what a structured on-chain observation
// IS, independent of who served it: a typed intent, a typed result, and
// the provenance needed to re-verify it later.
//
// Nothing here is chain-specific beyond the chain enum; per-chain address
// encoding, RPC method mapping and response decoding live in adapters.

export type OnchainChain = "solana";

// D-131 — production networks only. A test network is not weaker
// authority, it is a DIFFERENT asset universe, so v1 does not model one
// at all: there is no enum member for it and no endpoint configured, which
// makes testnet data structurally unreachable rather than filtered later.
export type OnchainNetwork = "mainnet";

export type OnchainIntentKind =
  | "TOKEN_SUPPLY"
  | "ACCOUNT_INFO"
  | "TOKEN_ACCOUNT_BALANCE"
  | "SIGNATURES_FOR_ADDRESS"
  | "TRANSACTION_DETAIL"
  // Which SPL token accounts a given wallet holds FOR ONE SPECIFIC MINT.
  // The mint filter is not a parameter a caller chooses: it is the
  // intent's projectAnchor, so this intent structurally cannot ask about
  // any mint other than the project's confirmed identity.
  | "TOKEN_ACCOUNTS_BY_OWNER";

// AMENDMENT C — the project ANCHOR and the queried SUBJECT are distinct
// and both are preserved. The anchor is the project's confirmed identity
// (its mint/contract); the subject is what this particular intent reads,
// which may be a derived account or a transaction. Collapsing them would
// make "some account related to something" indistinguishable from "this
// project's own token", which is exactly the confusion D-134 exists to
// prevent.
export type OnchainSubjectKind = "token" | "account" | "tx";

export interface OnchainIntent {
  kind: OnchainIntentKind;
  chain: OnchainChain;
  network: OnchainNetwork;
  // The project's confirmed identity address. Never derived, never
  // model-supplied — it comes from an ACTIVE PROJECT_IDENTITY record.
  projectAnchor: string;
  subjectKind: OnchainSubjectKind;
  // What this intent reads. Equal to projectAnchor for a direct token
  // read; a derived account or transaction otherwise (see AMENDMENT D:
  // a derived subject requires admitted provenance, never a guess).
  subject: string;
  // Bounded, intent-specific parameters. Never a free-form RPC payload.
  limit?: number;
}

// ---- typed results ---------------------------------------------------
// Each is a normalized projection of a validated RPC response. No field
// is optional-by-convenience: a missing value means the fact cannot be
// synthesized, not that a default is assumed.

export interface TokenSupplyResult {
  kind: "TOKEN_SUPPLY";
  mint: string;
  amountRaw: string; // integer string — never a float, never rounded
  decimals: number;
}

// A token account, as jsonParsed account data described it. Present ONLY
// when the account is program-owned by an SPL Token program AND the node
// returned a parsed mint — so a null here means "not established", never
// "not a token account".
//
// WHY THE MINT MATTERS MORE THAN THE BALANCE. A documented address that
// turns out to be a token account is only relevant to this project if it
// is a token account for THIS project.s mint. Without that field the
// binding cannot be made from this observation at all, and the honest
// alternative is to fail closed.
//
// `owner` here is the SPL token-account OWNER (the wallet with authority
// over it), which is a different concept from AccountInfoResult.ownerProgram
// (the program that owns the account.s data). They are never merged.
export interface ParsedTokenAccountRef {
  mint: string;
  owner: string | null;
  amountRaw: string | null;
  decimals: number | null;
  state: string | null;
}

// WHY THIS IS AN EXPLICIT THREE-STATE AND NOT A NULLABLE FIELD.
//
// A nullable tokenAccount collapses two different answers into one value:
// "this is not a token account" and "this MIGHT be one and we could not
// tell". A consumer reading null cannot distinguish them, and the first
// version of this projection duly had one that treated both as an ordinary
// wallet — turning a failure to establish token-account identity into
// positive evidence of non-token status. That is the exact inversion the
// engine refuses everywhere else.
//
// So the relation is stated, not inferred from a null.
export type TokenAccountRelation =
  // The account.s data is owned by a program that is not an SPL Token
  // program. It is genuinely not a token account, and asking which token
  // accounts it owns is a well-formed question.
  | "NOT_TOKEN_PROGRAM_OWNED"
  // Program-owned by SPL Token or Token-2022 AND the node parsed a
  // well-formed mint. `tokenAccount` carries it.
  | "TOKEN_ACCOUNT_PARSED"
  // Program-owned by an SPL Token program, but the parsed identity is
  // absent, malformed or unsupported. We know it is a token account and we
  // do NOT know which mint. Fail closed: it is neither usable as a bound
  // subject nor demotable to an ordinary wallet.
  | "TOKEN_PROGRAM_OWNED_UNRESOLVED";

export interface AccountInfoResult {
  kind: "ACCOUNT_INFO";
  address: string;
  exists: boolean;
  // The program that owns the account.s DATA. Not an economic owner.
  ownerProgram: string | null;
  executable: boolean | null;
  lamports: string | null;
  // Which of the three the account is. ALWAYS read this before
  // tokenAccount: it is the field that separates "not a token account"
  // from "could not be established".
  tokenAccountRelation: TokenAccountRelation;
  // Populated ONLY when tokenAccountRelation === "TOKEN_ACCOUNT_PARSED".
  // Null on both other relations, which is why it must never be read as a
  // classification on its own.
  tokenAccount: ParsedTokenAccountRef | null;
}

export interface TokenAccountBalanceResult {
  kind: "TOKEN_ACCOUNT_BALANCE";
  account: string;
  mint: string | null;
  amountRaw: string;
  decimals: number;
}

// ONE SPL token account, as the node parsed it and as this adapter
// re-validated it. Every field here was checked against the REQUEST
// before the row was admitted: the account address is well-formed, its
// program owner is an SPL Token program, and the parsed owner and mint
// equal the ones asked for. An entry that failed any of those is not
// present at all — it is dropped, never downgraded.
export interface TokenAccountRef {
  // The token account's own pubkey — a THIRD address, distinct from both
  // the project anchor and the documentary wallet that owns it.
  account: string;
  // Echoed back from the parsed response, having been checked equal to
  // the requested owner. Kept rather than assumed so the artifact records
  // what the node actually said.
  owner: string;
  mint: string;
  // Integer string, exactly as served. Never a number: a u64 balance
  // exceeds what a double can represent without loss, and a silently
  // rounded balance is a wrong fact that looks right.
  amountRaw: string;
  decimals: number;
}

export interface TokenAccountsByOwnerResult {
  kind: "TOKEN_ACCOUNTS_BY_OWNER";
  // The wallet asked about — an admitted documentary locator.
  owner: string;
  // The confirmed project mint the query was filtered to.
  mint: string;
  accounts: TokenAccountRef[];
  // How many returned entries failed binding and were dropped. An
  // observation about the RESPONSE, not about the chain: it exists so a
  // silently filtered result cannot be mistaken for a clean one.
  rejectedCount: number;
}

export interface SignatureRef {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: boolean;
  // The transaction's SPL Memo, when it carries one. Present in the RPC
  // response and previously discarded by the typed projection, which made
  // it impossible to tell a labelled operational transaction apart from an
  // unlabelled one without fetching each transaction in full — the
  // expensive read this field exists to avoid needing.
  //
  // UNTRUSTED, AND NOT A FACT. A memo is arbitrary text written by
  // whoever signed the transaction. Anyone can write "daily burn" into
  // one. It is a HINT for choosing which transaction is worth fetching,
  // never evidence of what a transaction did — that remains the job of
  // decoding the actual instructions. Bounded on the way in, because it
  // is externally controlled content entering artifact text.
  memo: string | null;
}

export interface SignaturesForAddressResult {
  kind: "SIGNATURES_FOR_ADDRESS";
  address: string;
  signatures: SignatureRef[];
}

// A deterministically decoded SPL Token Burn / BurnChecked instruction.
// Recognized ONLY by the adapter, from the actual instruction, never
// inferred from a transfer to an address that "looks like" a burn address
// (owner instruction, explicit).
export interface BurnInstructionRef {
  programId: string;
  instructionType: "Burn" | "BurnChecked";
  mint: string;
  sourceAccount: string;
  authority: string | null;
  amountRaw: string;
  decimals: number | null;
}

// ONE parsed SPL Token instruction, of a kind this adapter recognises.
// Deliberately NOT interpreted: a Transfer to an address someone calls a
// burn address is a TRANSFER, and CloseAccount is CloseAccount. Naming
// what an instruction IS is decoding; naming what it MEANS is not this
// layer's job and never becomes one.
export interface TokenInstructionRef {
  programId: string;
  // "burn" | "burnChecked" | "transfer" | "transferChecked" |
  // "closeAccount" — the RPC's own parsed type, lowercased by the node.
  type: string;
  mint: string | null;
  // Source/subject token account, where the instruction names one.
  account: string | null;
  destination: string | null;
  authority: string | null;
  amountRaw: string | null;
  decimals: number | null;
  // True when this came from meta.innerInstructions rather than the
  // top-level message — a CPI, not something the signer wrote directly.
  inner: boolean;
}

// A token balance as the RPC reported it, before or after execution.
// amountRaw stays a string for the same reason every other balance does.
export interface TokenBalanceRef {
  accountIndex: number;
  account: string | null;
  mint: string;
  owner: string | null;
  amountRaw: string;
  decimals: number;
}

export interface TransactionDetailResult {
  kind: "TRANSACTION_DETAIL";
  signature: string;
  slot: number;
  blockTime: number | null;
  succeeded: boolean;
  // Empty when the transaction contains no SPL burn instruction. An empty
  // list is NEVER a fact that no burn happened — absence of evidence is
  // not evidence of absence.
  burns: BurnInstructionRef[];
  // Every distinct program the transaction invoked, outer and inner.
  programs: string[];
  // The transaction's account keys, in order, bounded.
  accountKeys: string[];
  // Recognised SPL Token instructions, decoded but never interpreted.
  tokenInstructions: TokenInstructionRef[];
  // Creation/initialization/sync instructions, kept apart from movement.
  // Empty is NEVER a fact that an account was not created or initialized —
  // only that no such instruction was decoded from this transaction.
  lifecycleInstructions: AccountLifecycleRef[];
  preTokenBalances: TokenBalanceRef[];
  postTokenBalances: TokenBalanceRef[];
}

export type OnchainResult =
  | TokenAccountsByOwnerResult
  | TokenSupplyResult
  | AccountInfoResult
  | TokenAccountBalanceResult
  | SignaturesForAddressResult
  | TransactionDetailResult;

// ---- provenance ------------------------------------------------------
// Everything required to re-verify the observation later. Incomplete
// provenance makes an artifact ineligible to establish anything.

export interface OnchainProvenance {
  chain: OnchainChain;
  network: OnchainNetwork;
  projectAnchor: string;
  subjectKind: OnchainSubjectKind;
  subject: string;
  // Chain position of the observation.
  slot: number;
  blockTime: number | null;
  blockHash: string | null;
  finality: "finalized" | "confirmed";
  // How it was obtained. providerId identifies the endpoint by a
  // code-owned LABEL, never a URL and never a credential.
  retrievalMethod: "RPC";
  providerId: string;
  providerMethod: string;
  // Request parameters after redaction. Addresses are public; nothing
  // credential-bearing is ever placed here.
  requestParams: Record<string, string | number | boolean>;
  transactionSignature: string | null;
  retrievedAt: Date;
  rawResponseHash: string;
  artifactHash: string;
}

// ---- the trusted artifact -------------------------------------------
// SOURCE CLASS SAFETY (owner amendment): eligibility for
// ONCHAIN_VERIFIABLE must depend on trusted internal metadata produced by
// the registered retriever path — NOT on a URI prefix, which our own code
// generates and which any caller could imitate.
//
// The brand below is a module-private symbol. A structurally identical
// object literal built anywhere else does not carry it and cannot be
// forged: nothing outside this module can obtain the symbol's value, and
// TypeScript will not let an unbranded object satisfy the type. This is
// the "trusted structured-artifact marker" — the in-process half; the
// persisted half is the onchain_artifacts row, which only the retriever
// path writes.
declare const ONCHAIN_ARTIFACT_BRAND: unique symbol;

export interface OnchainArtifact {
  readonly [ONCHAIN_ARTIFACT_BRAND]: true;
  canonicalUri: string;
  intent: OnchainIntent;
  result: OnchainResult;
  provenance: OnchainProvenance;
  // Canonical JSON serialization of `result` — the literal text a
  // deterministic fact quotes from, so traceability is exact rather than
  // paraphrased.
  normalizedText: string;
}

// The ONLY constructor. Adapters call this; nothing else can produce a
// value of type OnchainArtifact.
export function brandOnchainArtifact(
  artifact: Omit<OnchainArtifact, typeof ONCHAIN_ARTIFACT_BRAND>,
): OnchainArtifact {
  return artifact as OnchainArtifact;
}

// Runtime companion to the compile-time brand, for the persistence and
// classification boundaries where a value may arrive as `unknown`.
export function isOnchainArtifact(value: unknown): value is OnchainArtifact {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<OnchainArtifact>;
  return (
    typeof a.canonicalUri === "string" &&
    typeof a.normalizedText === "string" &&
    !!a.intent &&
    !!a.result &&
    !!a.provenance
  );
}

// ---- account lifecycle ------------------------------------------------
// ONE parsed instruction that says something about how a token account
// came to exist, what it is, or that its wrapped-SOL balance was synced.
//
// WHY THIS IS SEPARATE FROM TokenInstructionRef. That type answers "what
// moved?" and its `authority` field is whoever signed a movement — an
// owner, a delegate or a multisig signer, indistinguishably. This type
// answers "who owns this account?", and the only fields that can answer it
// are an initialization's `owner` and an ATA creation's `wallet`. Keeping
// them in one shape would let an authority be read as an owner, which is
// the exact confusion that made an ephemeral account's ownership
// unrecoverable.
//
// FOUR CONCEPTS, NEVER COLLAPSED: owner, authority, payer and close
// destination are distinct roles. They are frequently the same address and
// that coincidence proves nothing, so each has its own field and no field
// is ever populated from another.
export interface AccountLifecycleRef {
  programId: string;
  // The RPC's own parsed type: createAccount | createAccountWithSeed |
  // transfer | create | createIdempotent | initializeAccount |
  // initializeAccount2 | initializeAccount3 | syncNative.
  type: string;
  inner: boolean;
  // The account being created, initialized or synced, where the
  // instruction names one.
  account: string | null;
  mint: string | null;
  // THE TOKEN-ACCOUNT OWNER, and only ever that. Populated exclusively
  // from an initializeAccount* `owner` or an ATA create `wallet`. Never
  // from an authority. Never from System createAccount's `owner`, which
  // names a PROGRAM, not a person — see assignedProgram.
  owner: string | null;
  // The program a System-created account was assigned to. A token account
  // is assigned to the SPL Token program; reading this as an owner would
  // report the Token program as the owner of every token account on
  // Solana.
  assignedProgram: string | null;
  // Who funded the account. Distinct from owner: paying rent for an
  // account confers no control over it.
  payer: string | null;
  source: string | null;
  destination: string | null;
  // String for the same reason every other on-chain amount is.
  lamports: string | null;
  // Named explicitly by ATA creation, so the token program behind an ATA
  // is decoded rather than assumed.
  tokenProgram: string | null;
}
