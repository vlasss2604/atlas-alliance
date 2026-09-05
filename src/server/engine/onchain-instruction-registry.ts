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

export interface KnownInstructionMethod {
  chain: OnchainInstructionChain;
  programId: string;
  // The method name exactly as the program's own IDL spells it. This is
  // the preimage, so it is not a label we chose — changing it changes the
  // discriminator and stops matching.
  method: string;
  // Precomputed from `method` at load. Never written by hand.
  discriminatorHex: string;
}

// Anchor programs whose dispatch this registry can read.
//
// SEEDED WITH EXACTLY WHAT THE REPOSITORY ALREADY CONFIRMED, and nothing
// else. The Raydium concentrated-liquidity swap_v2 entry restates the
// constant onchain-exchange-decoding.ts already derives and uses; a test
// asserts the two agree byte for byte. No entry is added for any program
// this repository has not independently confirmed — in particular no
// pump.fun program, whose ids appear nowhere in this codebase.
const ANCHOR_METHODS: { chain: OnchainInstructionChain; programId: string; method: string }[] = [
  {
    chain: "solana",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    method: "swap_v2",
  },
];

export const KNOWN_INSTRUCTION_METHODS: readonly KnownInstructionMethod[] = ANCHOR_METHODS.map(
  (e) => ({ ...e, discriminatorHex: anchorGlobal(e.method).toString("hex") }),
);

// Indexed by chain+program so an unknown program costs one map lookup and
// no scanning.
const BY_PROGRAM = new Map<string, KnownInstructionMethod[]>();
for (const entry of KNOWN_INSTRUCTION_METHODS) {
  const key = `${entry.chain}|${entry.programId}`;
  const list = BY_PROGRAM.get(key) ?? [];
  list.push(entry);
  BY_PROGRAM.set(key, list);
}

export function isProgramKnown(chain: OnchainInstructionChain, programId: string): boolean {
  return BY_PROGRAM.has(`${chain}|${programId}`);
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
