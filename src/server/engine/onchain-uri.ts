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
};

export function buildCanonicalOnchainUri(intent: OnchainIntent): string {
  return [
    `${SCHEME}//${intent.chain}`,
    intent.network,
    "project",
    intent.projectAnchor,
    intent.subjectKind,
    intent.subject,
    INTENT_PATH[intent.kind],
  ].join("/");
}

export interface ParsedOnchainUri {
  chain: string;
  network: string;
  projectAnchor: string;
  subjectKind: string;
  subject: string;
  intentPath: string;
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
  return {
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
