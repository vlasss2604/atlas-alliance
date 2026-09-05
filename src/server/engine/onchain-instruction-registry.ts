import { createHash } from "node:crypto";

// D-158 PHASE 1 — WHICH KNOWN METHOD AN INSTRUCTION'S BYTES NAME.
//
// GENERALISED FROM THE ONE MECHANISM THAT ALREADY WORKS, not added beside
// it. onchain-exchange-decoding.ts proved the shape: an Anchor instruction
// is dispatched on sha256("global:<method>")[0..8], so a method NAME is a
// hypothesis that either reproduces an observed 8-byte prefix exactly or is
// wrong. That file now imports `discriminator` from here, so there is one
// derivation in the codebase and the Raydium decoder and this registry
// cannot drift apart.
//
// WHAT THIS IS. A table of (chain, programId, method) whose discriminators
// are COMPUTED at module load from the method name. Nothing is pasted in as
// a magic constant, so a typo in a method name produces a value that
// matches nothing rather than a value that silently matches the wrong
// instruction.
//
// WHAT THIS IS NOT. A universal Solana decoder. It reads exactly one thing
// — the leading 8 bytes of an instruction the node did not parse — and
// answers with a method name or null. It does not read arguments, does not
// name accounts, does not assign meaning, and knows nothing about any
// project's mints or addresses.
//
// UNKNOWN IS THE DEFAULT AND IS NOT A DEFECT. A program with no entry, or
// an entry whose discriminator does not match, yields null. Absence of a
// decoded method is never evidence that the instruction did something else.
//
// THE MODEL CANNOT REACH THIS. Entries are code-owned constants in this
// file. No extraction output, no document, no prompt and no configuration
// can add, remove or match an entry.

export function discriminator(preimage: string): Buffer {
  return createHash("sha256").update(preimage).digest().subarray(0, 8);
}

// The Anchor convention. Kept as a named function rather than inlined so a
// future non-Anchor program can be given its own rule without pretending
// its dispatch works this way.
function anchorGlobal(method: string): Buffer {
  return discriminator(`global:${method}`);
}

export type OnchainInstructionChain = "solana";

// D-158 PHASE 2 — WHAT A KNOWN METHOD IS APPROVED TO HELP PROVE.
//
// WHY A ROLE IS NEEDED AT ALL. Phase 1 can prove "program P invoked the
// instruction that moved Y into A". That is not enough to establish where
// a protocol's value comes from, because withdrawals, refunds, rebates,
// payouts, liquidity removals and treasury movements all produce
// attributable transfers too. Knowing WHICH method ran is the missing
// half, and only a human reviewing the program's own IDL can say what that
// method does.
//
// CLOSED, CODE-OWNED, AND NEVER INFERRED. A role is data written in this
// file and reviewed as code. It is not derived from the method's name at
// runtime — "collect_fee" and "collect_reward" are one character apart in
// spirit and worlds apart in meaning, and a name heuristic would be a
// lexical classifier of exactly the kind this architecture rejected.
//
// ABSENT IS THE DEFAULT. A known method with no role proves nothing about
// value origin; an unknown method has no role to have. Neither is a defect
// and neither is evidence that the method does something else.
export const METHOD_PROOF_ROLES = [
  // The method's mechanical effect is the arrival of value AT the protocol
  // from outside it — a fee taken, a payment collected. Approved as one
  // half of a value-origin proof, and only ever WITH an attributable
  // transfer that corroborates it.
  //
  // IT STILL PROVES ONLY MECHANICS. Not that demand was genuine, not that
  // the amount is net of rebates or referrals, not that this is all of the
  // protocol's revenue, and not that the counterparty is independent.
  "PROTOCOL_VALUE_INFLOW",
] as const;

export type MethodProofRole = (typeof METHOD_PROOF_ROLES)[number];

// D-158 PHASE 2 CORRECTION — WHICH LEG OF THE METHOD IS THE VALUE RECEIPT.
//
// THE HOLE THIS CLOSES. A role on a method said "this instruction is where
// protocol value arrives", and the obligation then accepted ANY external
// asset transfer that instruction caused. One invocation of a fee
// collection routinely moves value to more than one place: the protocol's
// vault, a referrer, a rebate account, a partner share. Every one of those
// legs has the same program, the same method and the same external asset.
//
//   SAME QUALIFYING METHOD != SAME ECONOMIC LEG
//
// So a role is only usable together with a rule that names WHICH account
// of the invocation receives protocol value.
//
// WHY AN ACCOUNT INDEX. A Solana instruction is handed its accounts as an
// ORDERED list, and the order is part of the program's own interface: an
// IDL says "account 4 is the protocol fee vault" and the program would
// break if it were otherwise. That ordinal is therefore a deterministic,
// program-owned fact a human can read off the IDL and write down here —
// unlike an account NAME, which the chain does not report at all, and
// unlike prose, which is the opposite of machine-owned.
//
// A LIST, NOT A SINGLE INDEX, because one collection instruction may pay
// into two vaults (a token pair). Listing both is still deterministic;
// what it must never become is "any account this instruction touched".
export interface ValueRecipientRule {
  kind: "INSTRUCTION_ACCOUNT_INDEX";
  // Positions in the INVOKING instruction's own account list. Non-empty;
  // an empty list would mean "no leg qualifies" and is not expressible.
  indexes: readonly number[];
}

// A role NEVER travels alone. Pairing them in one object is what makes
// "approved role, but nobody knows which leg" unrepresentable rather than
// merely discouraged.
export interface MethodProofApproval {
  role: MethodProofRole;
  valueRecipient: ValueRecipientRule;
}

// Resolves the rule against one invocation's actual account list.
//
// FAILS CLOSED. Null — not an empty list, not a partial answer — whenever
// the accounts were not recorded, or the list is too short for a declared
// index. A truncated account list must read as "the leg is unknown",
// because a shorter list silently shifts every ordinal after it.
export function resolveValueRecipients(
  rule: ValueRecipientRule,
  callerAccounts: readonly string[] | null,
): string[] | null {
  if (callerAccounts === null) return null;
  if (rule.indexes.length === 0) return null;
  const out: string[] = [];
  for (const i of rule.indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= callerAccounts.length) return null;
    out.push(callerAccounts[i]);
  }
  return out;
}

export interface KnownInstructionMethod {
  chain: OnchainInstructionChain;
  programId: string;
  // The method name exactly as the program's own IDL spells it. This is
  // the preimage, so it is not a label we chose — changing it changes the
  // discriminator and stops matching.
  method: string;
  // Precomputed from `method` at load. Never written by hand.
  discriminatorHex: string;
  // Absent unless a human has reviewed this exact method AND its IDL
  // account order, and approved both what it may help establish and which
  // account of it receives protocol value. Absence is the norm, and an
  // approval that cannot name the leg is not expressible.
  proofApproval?: MethodProofApproval;
}

// Anchor programs whose dispatch this registry can read.
//
// SEEDED WITH EXACTLY WHAT THE REPOSITORY ALREADY CONFIRMED, and nothing
// else. The Raydium concentrated-liquidity swap_v2 entry restates the
// constant onchain-exchange-decoding.ts already derives and uses; a test
// asserts the two agree byte for byte. No entry is added for any program
// this repository has not independently confirmed — in particular no
// pump.fun program, whose ids appear nowhere in this codebase.
const ANCHOR_METHODS: {
  chain: OnchainInstructionChain;
  programId: string;
  method: string;
  proofApproval?: MethodProofApproval;
}[] = [
  {
    chain: "solana",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    method: "swap_v2",
    // NO ROLE, deliberately. A swap is an exchange between two parties; it
    // is not value arriving at a protocol from outside it. Reading a swap
    // as revenue origin is precisely the confusion this role exists to
    // prevent, so the one entry the repository has confirmed carries none.
  },
];

export const KNOWN_INSTRUCTION_METHODS: readonly KnownInstructionMethod[] = ANCHOR_METHODS.map(
  (e) => ({ ...e, discriminatorHex: anchorGlobal(e.method).toString("hex") }),
);

// TEST SEAM, and only that. Production passes nothing and reads the table
// above. It exists because a positive control needs a method carrying the
// inflow role, and no such program has been independently confirmed for
// this repository yet — inventing one in production data to make a test
// pass would be the worst possible reason to add a registry entry.
//
// A model cannot reach this: it is a function in a code module, callable
// only from code, and nothing in the extraction path imports it.
let _overlay: readonly KnownInstructionMethod[] | null = null;

export function __setInstructionRegistryOverlay(
  entries:
    | readonly {
        chain: OnchainInstructionChain;
        programId: string;
        method: string;
        proofApproval?: MethodProofApproval;
      }[]
    | null,
): void {
  _overlay =
    entries === null
      ? null
      : entries.map((e) => ({ ...e, discriminatorHex: anchorGlobal(e.method).toString("hex") }));
  rebuildIndex();
}

// Indexed by chain+program so an unknown program costs one map lookup and
// no scanning.
const BY_PROGRAM = new Map<string, KnownInstructionMethod[]>();

function rebuildIndex(): void {
  BY_PROGRAM.clear();
  for (const entry of [...KNOWN_INSTRUCTION_METHODS, ...(_overlay ?? [])]) {
    const key = `${entry.chain}|${entry.programId}`;
    const list = BY_PROGRAM.get(key) ?? [];
    list.push(entry);
    BY_PROGRAM.set(key, list);
  }
}
rebuildIndex();

export function isProgramKnown(chain: OnchainInstructionChain, programId: string): boolean {
  return BY_PROGRAM.has(`${chain}|${programId}`);
}

// The approval for one exact (chain, program, method), or null.
//
// THE LOOKUP IS BY IDENTITY, NOT BY NAME. A method name alone is
// meaningless — the same name under a different program is a different
// instruction — so a caller that has only a name cannot reach an approval.
//
// UNKNOWN IS UNMET, at every step: an unknown program, a method with no
// entry, and an entry with no approval all answer null identically.
export function proofApprovalForMethod(
  chain: OnchainInstructionChain,
  programId: string,
  method: string,
): MethodProofApproval | null {
  const entries = BY_PROGRAM.get(`${chain}|${programId}`);
  if (entries === undefined) return null;
  return entries.find((e) => e.method === method)?.proofApproval ?? null;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Base58 → bytes. Returns null for anything that is not well-formed base58,
// so a malformed blob is undecodable rather than partially read.
export function decodeBase58Bytes(value: string): Buffer | null {
  if (value.length === 0) return null;
  const bytes: number[] = [0];
  for (const ch of value) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit === -1) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const ch of value) {
    if (ch !== "1") break;
    leadingZeros++;
  }
  return Buffer.from([...new Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

// THE ONE QUESTION THIS MODULE ANSWERS: for a program we have an entry
// for, do the instruction's leading 8 bytes reproduce a known method's
// discriminator exactly?
//
// Exact match only. A prefix that is close, a program that emits the same
// bytes under a different id, or an entry-less program all yield null.
export function decodeKnownMethod(input: {
  chain: OnchainInstructionChain;
  programId: string;
  // Base58 instruction data, exactly as the node reported it.
  data: string;
}): string | null {
  const entries = BY_PROGRAM.get(`${input.chain}|${input.programId}`);
  if (entries === undefined) return null;
  const bytes = decodeBase58Bytes(input.data);
  if (bytes === null || bytes.length < 8) return null;
  const observed = bytes.subarray(0, 8).toString("hex");
  const hit = entries.find((e) => e.discriminatorHex === observed);
  return hit ? hit.method : null;
}
