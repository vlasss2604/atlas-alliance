import type {
  OnchainChain,
  OnchainIntent,
  OnchainNetwork,
  OnchainSubjectKind,
} from "./providers/onchain-types";

// Canonical identity for a structured on-chain observation.
//
//   atlas-onchain://<chain>/<network>/project/<ANCHOR>/<subjectKind>/<SUBJECT>/<intent>
//
// AMENDMENT C — the URI carries BOTH the project anchor and the queried
// subject as distinct path segments, so a derived-account observation can
// never be mistaken for a direct read of the project's own token, and the
// relationship survives into `sources`, dedup, trace and the ledger.
//
// Two deliberate properties:
//
//  1. It is NOT an http(s) URL. There is nothing to fetch, no host to
//     resolve, and ContentFetcher's protocol allowlist rejects it — so a
//     canonical URI can never be turned into a network request by any
//     existing path.
//
//  2. The anchor appears as a distinct path segment, which is what lets
//     D-134's existing urlReferencesAddress() recognize it unchanged. That
//     is a SECOND representation of containment for dedup and audit — it
//     is explicitly NOT the proof of entity binding (see
//     onchain-binding.ts). Our own code generates this string; a string
//     we generate can never be the evidence that the thing it describes is
//     genuine.
const SCHEME = "atlas-onchain:";

const INTENT_PATH: Record<OnchainIntent["kind"], string> = {
  TOKEN_SUPPLY: "supply",
  ACCOUNT_INFO: "info",
  TOKEN_ACCOUNT_BALANCE: "balance",
  SIGNATURES_FOR_ADDRESS: "signatures",
  TRANSACTION_DETAIL: "detail",
  // The SUBJECT is the wallet asked about; the token accounts it turns
  // out to hold are in the RESULT, never in the URI. A third address
  // discovered by a query does not belong in the identity of the query.
  TOKEN_ACCOUNTS_BY_OWNER: "token-accounts",
};

// The URI path segment for an intent kind, for callers that recognise a
// canonical URI by intent without composing a whole intent to do it.
export function onchainIntentPath(kind: OnchainIntent["kind"]): string {
  return INTENT_PATH[kind];
}

// AN EXPLICIT BLOCK IS PART OF THE TARGET. A read of the finalized head and
// a read at a named historical block are different acquisition targets, so
// the selector travels in the URI as `?block=<n>` — and ONLY when the
// intent carries one. An intent without it builds exactly the URI it always
// did, so every existing identity, source row and trace marker is unchanged.
const BLOCK_SELECTOR = "?block=";
const CANONICAL_BLOCK = /^(?:0|[1-9][0-9]*)$/;

export function buildCanonicalOnchainUri(intent: OnchainIntent): string {
  const base = [
    `${SCHEME}//${intent.chain}`,
    intent.network,
    "project",
    intent.projectAnchor,
    intent.subjectKind,
    intent.subject,
    INTENT_PATH[intent.kind],
  ].join("/");
  return intent.block === undefined ? base : `${base}${BLOCK_SELECTOR}${intent.block}`;
}

// WHAT IS OBSERVED, WITHOUT WHERE. A pinned read and a head read of the same
// token's supply observe one thing at two positions, exactly as two head
// reads at two slots always did — so they share one source row, and only the
// artifact (and its trace) carries the position. Identity for a URI with no
// selector.
export function onchainSourceUriOf(canonicalUri: string): string {
  const at = canonicalUri.indexOf(BLOCK_SELECTOR);
  return at === -1 ? canonicalUri : canonicalUri.slice(0, at);
}

// The pinned-read URI prefix for a base target, for a query that must find
// every explicit-block read of it and nothing else.
export function pinnedOnchainUriPrefix(baseUri: string): string {
  return `${baseUri}${BLOCK_SELECTOR}`;
}

export interface ParsedOnchainUri {
  chain: string;
  network: string;
  projectAnchor: string;
  subjectKind: string;
  subject: string;
  intentPath: string;
  // The explicit block selector, or null for a head read.
  block: number | null;
}

// Parses a canonical URI back into its parts. Returns null for anything
// that is not exactly this shape — callers must treat null as "not a
// structured artifact reference", never as a partial match.
export function parseCanonicalOnchainUri(uri: string): ParsedOnchainUri | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME) return null;
  const chain = parsed.hostname;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // network / "project" / anchor / subjectKind / subject / intentPath
  if (segments.length !== 6 || segments[1] !== "project") return null;
  if (!chain) return null;
  if (parsed.hash !== "") return null;
  // Nothing but the one selector this module writes. Any other query is not
  // a URI this code generated, and fails closed rather than parsing partly.
  let block: number | null = null;
  if (parsed.search !== "") {
    if (!parsed.search.startsWith(BLOCK_SELECTOR)) return null;
    const value = parsed.search.slice(BLOCK_SELECTOR.length);
    if (!CANONICAL_BLOCK.test(value)) return null;
    block = Number(value);
    if (!Number.isSafeInteger(block)) return null;
  }
  return {
    block,
    chain,
    network: segments[0],
    projectAnchor: segments[2],
    subjectKind: segments[3],
    subject: segments[4],
    intentPath: segments[5],
  };
}

export function isCanonicalOnchainUri(uri: string): boolean {
  return parseCanonicalOnchainUri(uri) !== null;
}

export function subjectKindOf(kind: OnchainIntent["kind"]): OnchainSubjectKind {
  switch (kind) {
    case "TOKEN_SUPPLY":
      return "token";
    case "TRANSACTION_DETAIL":
      return "tx";
    default:
      return "account";
  }
}

export type { OnchainChain, OnchainNetwork };
