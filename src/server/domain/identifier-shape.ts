import type { SupportedChain } from "./project-identity";

// IDENTIFIER SHAPE BY EVIDENCE ENVIRONMENT — the one place the structural
// shape of an on-chain identifier is stated, per chain family.
//
// WHY THIS EXISTS. Every locator-shaped check in the tree — the documentary
// locator validator, link discovery, embedded-record discovery, the
// acquisition subject gate — carried its own copy of ONE alphabet (base58,
// Solana's) and called the result "an identifier". That was exact for the
// only chain with a retriever and silently wrong for every other chain the
// project identity already admits: a valid Ethereum contract address is
// not base58, so generic code rejected it before any adapter could exist.
//
// A SHAPE IS A CLAIM ABOUT LENGTH AND ALPHABET, NEVER ABOUT MEANING. Passing
// here says "this string is structurally complete for that chain family".
// It does not say the address exists, is a token, is a contract, belongs to
// a project, or holds authority. Confirmation of any of that remains with
// the human ACTIVE identity record (D-133) and with entity binding
// (D-134); this module deliberately cannot answer either.
//
// TWO FAMILIES, DISJOINT BY CONSTRUCTION. A base58 identifier cannot start
// with "0x" ('0' is not in the alphabet), and an EVM identifier cannot be
// base58. So the union classifier below never has to choose: a string is in
// at most one family, and a family never masquerades as the other.
//
// SOLANA RECOGNITION IS UNCHANGED. The base58 ranges are the exact ones the
// four former copies used (address 32–44, signature 64–88), so every
// Solana path classifies exactly as before.

export type IdentifierFamily = "BASE58" | "EVM_HEX";

// The generic vocabulary the rest of the engine already uses. ADDRESS_LIKE
// is an account-shaped identifier; SIGNATURE_LIKE is a transaction-shaped
// one (a Solana signature or an EVM transaction hash — the name predates
// the second family and is kept because a persisted enum carries it).
export type IdentifierShape = "ADDRESS_LIKE" | "SIGNATURE_LIKE";

// Base58 (no 0, O, I, l). A Solana address is 32 bytes -> 32-44 chars; a
// signature is 64 bytes -> 87-88 chars (the range is kept as it always was).
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE58_CHAR = /[1-9A-HJ-NP-Za-km-z]/;

// EVM: 0x + 40 hex (20-byte address), 0x + 64 hex (32-byte transaction
// hash). Case is NOT significant here — EIP-55 checksum and lowercase are
// two spellings of one address — but a shape check does not canonicalise;
// it only recognises. Structural only: no checksum verification, no
// contract/EOA distinction, no ABI, no token role.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_HEX_CHAR = /[0-9a-fA-Fx]/;

// Code-owned and total over SUPPORTED_CHAINS: a chain the identity record
// admits always has a family here, so adding a chain to one list without
// the other is a type error, not a silent null.
const FAMILY_BY_CHAIN: Record<SupportedChain, IdentifierFamily> = {
  solana: "BASE58",
  ethereum: "EVM_HEX",
  bsc: "EVM_HEX",
  polygon: "EVM_HEX",
  arbitrum: "EVM_HEX",
  base: "EVM_HEX",
  optimism: "EVM_HEX",
  avalanche: "EVM_HEX",
};

export function identifierFamilyOfChain(chain: SupportedChain): IdentifierFamily {
  return FAMILY_BY_CHAIN[chain];
}

function shapeInFamily(family: IdentifierFamily, value: string): IdentifierShape | null {
  // Longest-first within each family states the intent; the ranges do not
  // overlap in either family.
  if (family === "BASE58") {
    if (BASE58_SIGNATURE.test(value)) return "SIGNATURE_LIKE";
    if (BASE58_ADDRESS.test(value)) return "ADDRESS_LIKE";
    return null;
  }
  if (EVM_TRANSACTION_HASH.test(value)) return "SIGNATURE_LIKE";
  if (EVM_ADDRESS.test(value)) return "ADDRESS_LIKE";
  return null;
}

// The shape of `value` FOR THIS CHAIN, or null. This is the environment-
// aware check: an 0x address asked about under `solana` is null — not
// "an address on some other chain", simply not an identifier here.
export function identifierShapeForChain(
  chain: SupportedChain,
  value: string,
): IdentifierShape | null {
  return shapeInFamily(identifierFamilyOfChain(chain), value);
}

// The family a string structurally belongs to, if any. Used where no chain
// is known yet (link discovery inside a document, a record embedded in a
// page) — it names a family, never a chain, and never picks one when the
// string fits neither.
export function identifierFamilyOfValue(value: string): IdentifierFamily | null {
  if (shapeInFamily("BASE58", value) !== null) return "BASE58";
  if (shapeInFamily("EVM_HEX", value) !== null) return "EVM_HEX";
  return null;
}

// The shape of `value` in WHICHEVER family it structurally fits. Because
// the families are disjoint this is a lookup, not a preference: a base58
// string is classified exactly as before, an EVM string is classified as
// its own family, and everything else is null. A caller that knows the
// chain must use identifierShapeForChain instead.
export function identifierShapeOfAnyFamily(value: string): IdentifierShape | null {
  const family = identifierFamilyOfValue(value);
  return family === null ? null : shapeInFamily(family, value);
}

// Is `ch` a character that could continue an identifier of this family?
// Used by literal-presence checks to refuse a match that is really part
// of a longer identifier. For base58 this is exactly the boundary rule the
// documentary locator always applied.
export function identifierBoundaryCharOfFamily(family: IdentifierFamily): RegExp {
  return family === "BASE58" ? BASE58_CHAR : EVM_HEX_CHAR;
}
