import { z } from "zod";

// D-133 — confirmed project identity and locators.
//
// Why this exists: a live run steered `site:etherscan.io pump.fun ...`,
// found an unrelated Ethereum ERC-20 that merely MATCHED THE NAME, and
// used it to PARTIALLY_SUPPORT claims about a Solana asset. Wrong chain,
// wrong contract, wrong asset, presented as on-chain proof.
//
// The structural cure is to stop searching shared platforms by NAME and
// start addressing them by a globally unique, human-confirmed
// IDENTIFIER. A token mint/contract address is unique across a chain; a
// project name is not unique across anything. Targeting by address is
// what makes a shared, multi-tenant host safe to use for one project.
//
// Two independent record kinds, both stored as project_memory_items and
// both human-confirmed by the SAME existing mechanism (lifecycleState =
// 'ACTIVE'; anything else is not confirmed):
//
//   PROJECT_IDENTITY — WHICH entity: { chain, tokenAddress?, ticker? }
//   SOURCE_ROUTE     — WHERE to look: { domain, routeClass? }   (D-074)
//
// Neither is evidence. A locator narrows acquisition to the right entity;
// it never establishes, supports or contradicts a research claim. All
// admissibility (S5 establishingClasses, S7 support logic, the officiality
// axis) is untouched by anything in this file.

// Chains ATLAS can address by explorer. Deliberately a small, code-owned,
// project-independent list — the same discipline as source-authority.ts's
// domain lists. A chain absent here simply has no explorer locator; it is
// never guessed.
export const SUPPORTED_CHAINS = [
  "solana",
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "base",
  "optimism",
  "avalanche",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

// MAINNET explorer hosts per chain, in preference order.
//
// This mapping is what makes cross-chain contamination structurally
// impossible: a project confirmed on `solana` can only ever be addressed
// at Solana explorers, so an etherscan.io page can never be acquired as
// that project's on-chain evidence no matter what its text says.
//
// Every host here is one source-authority.ts independently classifies as
// ONCHAIN_VERIFIABLE, and every one is a MAINNET host — test networks are
// excluded by construction here and rejected again at classification time
// (isTestNetworkHost, D-131). A testnet can never satisfy production
// identity.
const CHAIN_EXPLORERS: Record<SupportedChain, readonly string[]> = {
  solana: ["solscan.io", "solana.fm"],
  ethereum: ["etherscan.io"],
  bsc: ["bscscan.com"],
  polygon: ["polygonscan.com"],
  arbitrum: ["arbiscan.io"],
  base: ["basescan.org"],
  optimism: ["optimistic.etherscan.io"],
  avalanche: ["snowtrace.io"],
};

// Address shapes are validated only for OBVIOUS structural sanity, never
// for ownership: a well-formed address is not a confirmed one. Confirmation
// is exclusively the human ACTIVE-row decision.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58, no 0/O/I/l — Solana mints are 32-44 chars.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const projectIdentityContentSchema = z
  .object({
    chain: z.enum(SUPPORTED_CHAINS),
    // The token's mint (Solana) or contract (EVM) address. Optional: a
    // project may be confirmed on a chain before its token address is.
    tokenAddress: z.string().min(1).max(120).optional(),
    // Informational only — never used for matching. The catalog's own
    // projects.ticker stays the display authority.
    ticker: z.string().min(1).max(32).optional(),
  })
  .strict();

export type ProjectIdentityContent = z.infer<typeof projectIdentityContentSchema>;

// True when the address is structurally plausible FOR THAT CHAIN. Used to
// reject an obviously cross-chain record (an 0x… address filed under
// solana), never to infer or confirm ownership.
export function addressShapeMatchesChain(chain: SupportedChain, address: string): boolean {
  if (chain === "solana") return SOLANA_ADDRESS.test(address);
  return EVM_ADDRESS.test(address);
}

export interface ConfirmedProjectIdentity {
  chain: SupportedChain;
  tokenAddress: string | null;
  ticker: string | null;
}

// Parses a stored PROJECT_IDENTITY content blob. Returns null for
// anything that does not satisfy the contract — an unparseable or
// self-inconsistent record confers no identity at all rather than a
// partial one. Chain/address disagreement is treated as unusable for
// exactly the reason this module exists.
export function parseProjectIdentity(content: unknown): ConfirmedProjectIdentity | null {
  const parsed = projectIdentityContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const { chain, tokenAddress, ticker } = parsed.data;
  if (tokenAddress && !addressShapeMatchesChain(chain, tokenAddress)) return null;
  return { chain, tokenAddress: tokenAddress ?? null, ticker: ticker ?? null };
}

// The explorer hosts ATLAS may address for a confirmed identity. Empty
// when the chain is unknown to the code-owned map — never a fallback to
// "some other chain's explorer".
export function explorerHostsForChain(chain: SupportedChain): readonly string[] {
  return CHAIN_EXPLORERS[chain] ?? [];
}

// The acquisition locators for a confirmed identity: `site:<explorer>
// <tokenAddress>`.
//
// The query text is the ADDRESS, not the project name. That is the whole
// point — an address is globally unique, so the result set cannot contain
// a different project that merely shares a name. Without a confirmed
// tokenAddress there is no locator at all; the chain alone does not make
// a shared explorer safe to search by name.
export function explorerLocatorsForIdentity(
  identity: ConfirmedProjectIdentity,
  maxHosts = 2,
): string[] {
  if (!identity.tokenAddress) return [];
  return explorerHostsForChain(identity.chain)
    .slice(0, maxHosts)
    .map((host) => `site:${host} ${identity.tokenAddress}`);
}
