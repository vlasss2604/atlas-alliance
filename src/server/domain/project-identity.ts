import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database, Transaction } from "../db/client";
import { projectMemoryItems } from "../db/schema";
import { identifierShapeForChain } from "./identifier-shape";

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
// is exclusively the human ACTIVE-row decision. The shapes themselves are
// stated once, per chain family, in identifier-shape.ts.

export const projectIdentityContentSchema = z
  .object({
    chain: z.enum(SUPPORTED_CHAINS),
    // The token's mint (Solana) or contract (EVM) address. Optional: a
    // project may be confirmed on a chain before its token address is.
    tokenAddress: z.string().min(1).max(120).optional(),
    // Informational only — never used for matching. The catalog's own
    // projects.ticker stays the display authority.
    ticker: z.string().min(1).max(32).optional(),
    // D-158 PHASE 1 — WHICH ON-CHAIN PROGRAM IS WHICH NAMED ACTIVITY.
    //
    // A project's documentation names its activities in prose ("bonding
    // curve", "PumpSwap"). On-chain, an activity exists only as a program.
    // Nothing in ATLAS could previously hold that correspondence, so an
    // attributed invocation could never be tied to the activity a document
    // names.
    //
    // HUMAN-CONFIRMED, exactly like tokenAddress and like SOURCE_ROUTE.
    // This record is written only through the confirmation path; no
    // extraction output, no document and no model can add or alter an
    // entry. `activity` is a free label because it is only ever DISPLAYED
    // and compared to itself — matching is on the programId, which is the
    // globally unique half.
    //
    // Optional and bounded. A project with no confirmed programs simply has
    // none, and an absent list is never read as "no such program exists on
    // chain".
    programs: z
      .array(
        z
          .object({
            activity: z.string().min(1).max(64),
            programId: z.string().min(1).max(120),
            // D-158 PHASE 2 — OTHER NAMES A HUMAN HAS CONFIRMED FOR THIS
            // SAME ACTIVITY. Documents do not spell an activity the way an
            // operator does: a project's own docs may say "the bonding
            // curve", "curve trading" and "Pump AMM" for things a human
            // knows are one activity. Code cannot decide that, and an LLM
            // deciding it would put the activity binding back in the
            // model's hands.
            //
            // So an alias is a HUMAN STATEMENT, entered the same way the
            // activity itself is, bounded and small. Absent is normal.
            aliases: z.array(z.string().min(1).max(64)).max(8).optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();

export type ProjectIdentityContent = z.infer<typeof projectIdentityContentSchema>;

// True when the address is structurally plausible FOR THAT CHAIN. Used to
// reject an obviously cross-chain record (an 0x… address filed under
// solana), never to infer or confirm ownership.
export function addressShapeMatchesChain(chain: SupportedChain, address: string): boolean {
  return identifierShapeForChain(chain, address) === "ADDRESS_LIKE";
}

export interface ConfirmedProgram {
  activity: string;
  programId: string;
  // Human-confirmed alternative names for the SAME activity. Optional and
  // minimal; nothing derives them, and no model may add one.
  aliases?: string[];
}

export interface ConfirmedProjectIdentity {
  chain: SupportedChain;
  tokenAddress: string | null;
  ticker: string | null;
  // OPTIONAL, AND THE DIFFERENCE MATTERS — the same distinction
  // rawInstructions draws. parseProjectIdentity ALWAYS sets it, so an
  // identity that came from a stored record carries [] when a human
  // confirmed no programs. Absent belongs only to an identity assembled
  // by hand in a script or fixture, which has made no statement about
  // programs at all. A consumer must read absent as "not stated", never
  // as "none exist on chain".
  programs?: ConfirmedProgram[];
}

// Parses a stored PROJECT_IDENTITY content blob. Returns null for
// anything that does not satisfy the contract — an unparseable or
// self-inconsistent record confers no identity at all rather than a
// partial one. Chain/address disagreement is treated as unusable for
// exactly the reason this module exists.
export function parseProjectIdentity(content: unknown): ConfirmedProjectIdentity | null {
  const parsed = projectIdentityContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const { chain, tokenAddress, ticker, programs } = parsed.data;
  if (tokenAddress && !addressShapeMatchesChain(chain, tokenAddress)) return null;
  // A program id that is not a valid address ON THIS CHAIN makes the whole
  // record unusable, exactly as a mismatched tokenAddress does. Dropping
  // only the bad entry would leave a record that looks fully confirmed
  // while quietly having lost part of what a human approved.
  if (programs?.some((e) => !addressShapeMatchesChain(chain, e.programId))) return null;
  return {
    chain,
    tokenAddress: tokenAddress ?? null,
    ticker: ticker ?? null,
    programs: programs ? programs.map((e) => ({ ...e })) : [],
  };
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

// D-134 — RISK 2 closure: query targeting by exact address is much safer
// than by name, but targeting alone does not PROVE the page acquired is
// about the right entity (a search result can still surface an unrelated
// page). This is the deterministic check applied at evidence-persist
// time: does the URL itself name the confirmed address, as a distinct
// path segment or an exact query-parameter value — never a substring
// match, which could accidentally match inside an unrelated longer token.
//
// Solana addresses are compared case-sensitively (base58 is
// case-significant). EVM addresses are compared case-insensitively,
// because checksummed (EIP-55) and lowercase forms of the SAME address
// are both valid and appear interchangeably across explorers.
//
// EXPORTED so the deterministic binding layer applies the same rule rather
// than a second copy of it: address equality is a property of the chain
// family, stated once.
export function chainAddressesEqual(chain: SupportedChain, a: string, b: string): boolean {
  return chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();
}

export function urlReferencesAddress(
  url: string,
  chain: SupportedChain,
  address: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.some((seg) => chainAddressesEqual(chain, seg, address))) return true;
  for (const value of parsed.searchParams.values()) {
    if (chainAddressesEqual(chain, value, address)) return true;
  }
  return false;
}

// D-134 — the eligibility gate itself: whether a piece of ONCHAIN_VERIFIABLE
// evidence, from this URL, may be treated as evidence FOR this project's
// confirmed identity. Deliberately fail-closed: no confirmed identity, no
// confirmed address, or a URL that simply does not name the address, all
// resolve to UNVERIFIED — never a guess, never "probably fine".
//
// This does NOT change what evidenceSourceClass a page IS (a wrong-asset
// Etherscan page is still genuinely ONCHAIN_VERIFIABLE data, per its own
// axis) — it only decides whether that ONCHAIN_VERIFIABLE page may
// establish a component FOR THIS PROJECT. SOURCE != EVIDENCE != FACT: this
// is a THIRD axis (entity binding), independent of sourceClass and
// officiality (D-074's two axes) — see evidence.entity_binding.
export function computeEntityBinding(
  url: string,
  sourceClass: string | null,
  identity: ConfirmedProjectIdentity | null,
): "CONFIRMED" | "UNVERIFIED" | null {
  if (sourceClass !== "ONCHAIN_VERIFIABLE") return null; // axis not applicable
  if (!identity?.tokenAddress) return "UNVERIFIED";
  return urlReferencesAddress(url, identity.chain, identity.tokenAddress) ? "CONFIRMED" : "UNVERIFIED";
}

// D-134 — the DB-aware counterpart to parseProjectIdentity: the project's
// confirmed identity, read the SAME way SOURCE_ROUTE is (ACTIVE
// project_memory_items rows only — D-074). When multiple ACTIVE rows
// exist, the first structurally-valid one (by createdAt) is used; this
// mirrors SOURCE_ROUTE's "one confirmed record wins" simplicity rather
// than inventing a conflict-resolution scheme this module was not asked
// to have.
export async function resolveConfirmedIdentity(
  db: Database | Transaction,
  projectId: string | null,
): Promise<ConfirmedProjectIdentity | null> {
  if (!projectId) return null;
  const rows = await db
    .select({ content: projectMemoryItems.content, createdAt: projectMemoryItems.createdAt })
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, projectId),
        eq(projectMemoryItems.kind, "PROJECT_IDENTITY"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const row of rows) {
    const identity = parseProjectIdentity(row.content);
    if (identity) return identity;
  }
  return null;
}
