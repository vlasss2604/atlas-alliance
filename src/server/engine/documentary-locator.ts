// EXACT DOCUMENTARY LOCATOR — the deterministic check that decides whether
// a fact may carry a concrete on-chain locator.
//
// THE DEFECT THIS CLOSES. A confirmed OFFICIAL_DOCS page rendered
// "99mRw3…pm4F3c" as the visible text of an anchor whose href carried the
// full 44-character account. Extraction quoted what it saw. The resulting
// Evidence was a true documentary observation and a useless locator: the
// middle characters are simply not knowable from it, and no amount of
// model instruction changes that. A prompt can prefer the exact value;
// only code can refuse the truncated one.
//
// This module is that code. It is the AUTHORITY: extraction may propose a
// locator, and nothing it proposes is trusted until this function agrees.
// A model that ignores its instruction produces no locator here, not a
// bad one.
//
// THE RULES, in order, each with its own reason so a rejection is
// diagnosable rather than merely a "no":
//
//   1. A truncated display form is never a locator. Not repaired, not
//      approximated, not looked up — refused.
//   2. A locator must be a COMPLETE machine-readable identifier.
//   3. It must appear LITERALLY in the normalized document text. This is
//      what makes reconstruction structurally impossible: a value with a
//      guessed middle does not appear in the document, so it cannot pass.
//      Where it appears — ordinary prose, an exact anchor href, a safe
//      data-* value, or the bounded link appendix — is deliberately not
//      constrained, because all four are the document literally stating
//      it. A page that writes the address out in prose needs no appendix.
//
// CASE SENSITIVITY IS LOAD-BEARING. Base58 is case-significant: two
// identifiers differing only in case are different accounts. The
// containment check here is exact, unlike D-076's traceability check,
// which lowercases because it compares human-readable prose.
//
// NO PROJECT KNOWLEDGE. There is no host, no project and no mechanism in
// this file. It decides shape and literal presence, nothing else. Whether
// a well-formed identifier is the RIGHT account, on the right chain, for
// the right project remains D-134's question, and this module deliberately
// cannot answer it — passing here means "the document states this
// identifier", never "this identifier is what it claims".
//
// ENVIRONMENT-AWARE SHAPE. What counts as a complete identifier depends
// on the chain family (base58 for Solana, 0x-hex for EVM), and the family
// rules live in ONE place — domain/identifier-shape.ts. A caller that
// knows the project's confirmed chain passes it, and only that chain's
// family is recognised: an 0x address proposed for a Solana project is
// "not an identifier" here, exactly as it always was. A caller with no
// confirmed chain gets the union of families — still a shape check, and
// still never a chain attribution.

import {
  identifierBoundaryCharOfFamily,
  identifierFamilyOfValue,
  identifierShapeForChain,
  identifierShapeOfAnyFamily,
} from "../domain/identifier-shape";
import type { SupportedChain } from "../domain/project-identity";

// The elision markers a page uses when it abbreviates an identifier for
// display. A complete base58 identifier can contain none of them, so any
// one is decisive on its own. This list exists to produce a PRECISE
// reason: anything it misses still fails the shape test below, just with
// the blunter "not an identifier".
const TRUNCATION_MARKERS = ["…", "⋯", "···", "..", "•••", "‥"];

export type LocatorShape = "ADDRESS_LIKE" | "SIGNATURE_LIKE";

export type LocatorRejection =
  // The fact claims no locator at all — the ordinary case, and not a
  // defect. Most documentary evidence identifies no account.
  | "NOT_CLAIMED"
  // "99mRw3…pm4F3c" and every other abbreviated rendering.
  | "TRUNCATED_DISPLAY_FORM"
  // Not an identifier this system recognises the shape of.
  | "NOT_A_COMPLETE_IDENTIFIER"
  // Well-formed, but the document does not contain it. A reconstructed,
  // guessed or externally-supplied value lands here.
  | "NOT_LITERAL_IN_DOCUMENT"
  // An EVM 0x+64-hex value whose every known occurrence is deterministically
  // NOT a transaction reference (see classifyEvmTransactionReference).
  | "NOT_A_TRANSACTION_REFERENCE";

export type DocumentaryLocatorOutcome =
  | {
      locator: "CONFIRMED";
      value: string;
      shape: LocatorShape;
      // Present ONLY for an EVM transaction-shaped value: true when the
      // document also presents it in an explicit transaction path
      // (`/tx/<hash>`). ORDERS admission; never admits or refuses anything.
      // Absent for every other value, so their outcome is exactly what it
      // always was.
      transactionStructured?: boolean;
    }
  | { locator: "NONE"; reason: LocatorRejection };

export function isTruncatedDisplayForm(value: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => value.includes(marker));
}

// The shape of a value FOR A CHAIN when one is known, or in whichever
// family it structurally fits when none is. Solana base58 recognition is
// exactly what it always was in both forms.
export function completeIdentifierShape(
  value: string,
  chain: SupportedChain | null = null,
): LocatorShape | null {
  return chain === null ? identifierShapeOfAnyFamily(value) : identifierShapeForChain(chain, value);
}

// Exact, case-sensitive containment with an identifier boundary on both
// sides, where "identifier character" is decided by the value's own family
// (base58 for a base58 value, hex for an 0x value).
//
// The boundary is not decoration. Without it a 44-character address would
// "appear literally" inside an 88-character signature that merely happens
// to contain those characters, and a fact could claim an account the
// document never names. A neighbouring identifier character means the
// match is part of a longer identifier, so it is not this identifier.
export function literallyPresent(documentText: string, value: string): boolean {
  return boundedOccurrences(documentText, value).length > 0;
}

// Every position at which `value` stands as a whole identifier in `text`,
// under exactly the boundary rule literal presence has always used —
// enumerated rather than answered once.
function boundedOccurrences(text: string, value: string): number[] {
  if (value.length === 0) return [];
  const boundaryChar = identifierBoundaryCharOfFamily(identifierFamilyOfValue(value) ?? "BASE58");
  const out: number[] = [];
  let from = text.indexOf(value);
  while (from >= 0) {
    const before = from === 0 ? "" : text[from - 1];
    const afterIndex = from + value.length;
    const after = afterIndex >= text.length ? "" : text[afterIndex];
    const boundedLeft = before === "" || !boundaryChar.test(before);
    const boundedRight = after === "" || !boundaryChar.test(after);
    if (boundedLeft && boundedRight) out.push(from);
    from = text.indexOf(value, from + 1);
  }
  return out;
}

// ---- EVM TRANSACTION-REFERENCE STRUCTURE --------------------------------
//
// A transaction hash and any other 32-byte keccak output have the same
// shape, and no rule over the 64 hex characters can tell them apart. What
// CAN tell them apart, deterministically, is STRUCTURE the document itself
// states around the value: the URL segment it follows, the Safe identifier
// it is embedded in, or its being an exact published constant.
//
// EXCLUSION ONLY, AND ONLY WHEN EVERY KNOWN OCCURRENCE AGREES. A value that
// also stands anywhere as bare prose, in an unrecognised URL, or in a
// transaction path stays admissible — a real transaction written directly
// in official docs is never lost to this rule. No word near the value
// ("proposal", "event", "hash") is read: the only inputs are the exact URL
// characters immediately before the value, and exact constants.
//
// THE STRUCTURE CLASSIFIES THE IDENTIFIER, NEVER THE CLAIM. A `/tx/` link on
// an explorer host says the value names a transaction; it confers no
// authority, officiality or binding — the document that contains it is the
// source, exactly as before.
//
// No RPC is involved. A value this does not recognise keeps today's path,
// where a non-transaction still fails closed at the receipt read.

// Exact 32-byte values that are provably not Ethereum transaction hashes:
// all-zero, and keccak256 outputs of fixed published preimages (a
// transaction hash equal to one would be a keccak collision). Each is
// re-derived from its preimage in tests/evm-transaction-reference.test.ts.
// Small on purpose: not a catalogue.
export const KNOWN_NON_TRANSACTION_BYTES32: ReadonlyMap<string, string> = new Map([
  ["0x0000000000000000000000000000000000000000000000000000000000000000", "all-zero bytes32"],
  ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "Transfer(address,address,uint256)"],
  ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", "Approval(address,address,uint256)"],
  ["0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31", "ApprovalForAll(address,address,bool)"],
  ["0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62", "TransferSingle(address,address,address,uint256,uint256)"],
  ["0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb", "TransferBatch(address,address,address,uint256[],uint256[])"],
  ["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "EIP-1967 implementation slot"],
  ["0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", "EIP-1967 admin slot"],
  ["0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", "EIP-1967 beacon slot"],
]);

const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

type OccurrenceStructure = "TRANSACTION" | "NON_TRANSACTION" | "NONE";

// What the characters IMMEDIATELY before an occurrence say about it: exact
// URL suffixes and nothing else. Lowercased because URL paths are written
// either way; the value itself is always compared exactly.
const PREFIX_WINDOW = 128;
function structureBefore(prefix: string): OccurrenceStructure {
  const p = prefix.slice(-PREFIX_WINDOW).toLowerCase();
  if (p.endsWith("/tx/") || p.endsWith("/transaction/")) return "TRANSACTION";
  // Snapshot-style: https://snapshot.org/#/<space>/proposal/<id>
  if (p.endsWith("/proposal/")) return "NON_TRANSACTION";
  // Safe transaction service: /multisig-transactions/<safeTxHash>
  if (p.endsWith("/multisig-transactions/")) return "NON_TRANSACTION";
  // Safe app: ?...&id=multisig_<safe address>_<safeTxHash>
  if (/[?&]id=multisig_0x[0-9a-f]{40}_$/.test(p)) return "NON_TRANSACTION";
  return "NONE";
}

// How one href presents the value: TRANSACTION if any occurrence in it is
// transaction-structured, NON_TRANSACTION if every occurrence is excluded
// structure, NONE otherwise — including an href that does not contain it.
function hrefStructure(href: string, value: string): OccurrenceStructure {
  const at = boundedOccurrences(href, value);
  if (at.length === 0) return "NONE";
  const kinds = at.map((i) => structureBefore(href.slice(0, i)));
  if (kinds.includes("TRANSACTION")) return "TRANSACTION";
  if (kinds.every((k) => k === "NON_TRANSACTION")) return "NON_TRANSACTION";
  return "NONE";
}

// The link-appendix line this codebase writes itself
// (providers/document-links.ts renderLinkAppendix): an occurrence in the
// `text=` or `resolves=` field of a `[LINK] href=...` line is that link's
// anchor, so it takes the structure of that line's href.
const APPENDIX_LINE = "[LINK] href=";
const APPENDIX_FIELD_SEPARATOR = " | ";
function appendixAnchorStructure(text: string, index: number, value: string): OccurrenceStructure | null {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  if (!text.startsWith(APPENDIX_LINE, lineStart)) return null;
  const before = text.slice(lineStart, index);
  if (
    !before.endsWith(`${APPENDIX_FIELD_SEPARATOR}text=`) &&
    !before.endsWith(`${APPENDIX_FIELD_SEPARATOR}resolves=`)
  ) {
    return null;
  }
  const hrefStart = lineStart + APPENDIX_LINE.length;
  const hrefEnd = text.indexOf(APPENDIX_FIELD_SEPARATOR, hrefStart);
  return hrefStructure(text.slice(hrefStart, hrefEnd < 0 ? undefined : hrefEnd), value);
}

export interface StructuredLink {
  href: string;
  text: string;
}

export type EvmTransactionReference =
  // Some occurrence sits in an explicit transaction path. Admissible, and
  // ordered first.
  | "TRANSACTION_STRUCTURED"
  // Some occurrence is bare prose or an unrecognised structure. Admissible,
  // exactly as before this rule existed.
  | "UNSTRUCTURED"
  // Every known occurrence is excluded structure, or the value is an exact
  // known constant. Refused as NOT_A_TRANSACTION_REFERENCE.
  | "NON_TRANSACTION";

// Classifies an EVM 0x+64-hex value from the document text and, when the
// fetch produced them, the page's structured links. Links are an ADDITIONAL
// view of the same page: they add occurrences (an href the plain text
// dropped) and can explain a bare occurrence that is only a link's anchor
// text — they never remove one.
export function classifyEvmTransactionReference(input: {
  value: string;
  documentText: string;
  links?: readonly StructuredLink[] | null;
}): EvmTransactionReference {
  const value = input.value;
  if (KNOWN_NON_TRANSACTION_BYTES32.has(value.toLowerCase())) return "NON_TRANSACTION";
  const links = input.links ?? [];

  const kinds: OccurrenceStructure[] = [];
  let bareTextOccurrences = 0;
  for (const i of boundedOccurrences(input.documentText, value)) {
    const anchor = appendixAnchorStructure(input.documentText, i, value);
    if (anchor !== null) {
      kinds.push(anchor);
      continue;
    }
    const k = structureBefore(input.documentText.slice(Math.max(0, i - PREFIX_WINDOW), i));
    if (k === "NONE") bareTextOccurrences += 1;
    else kinds.push(k);
  }
  for (const link of links) {
    const k = hrefStructure(link.href, value);
    if (k !== "NONE") kinds.push(k);
  }

  // A bare text occurrence is explained away ONLY when it can be nothing but
  // the anchor text of excluded links: every link whose visible text is
  // exactly this value points into excluded structure, and there are at
  // least as many such links as bare occurrences. Any doubt keeps it bare.
  if (bareTextOccurrences > 0) {
    const anchors = links.filter((l) => l.text.trim() === value);
    if (
      anchors.length >= bareTextOccurrences &&
      anchors.every((l) => hrefStructure(l.href, value) === "NON_TRANSACTION")
    ) {
      for (let n = 0; n < bareTextOccurrences; n += 1) kinds.push("NON_TRANSACTION");
      bareTextOccurrences = 0;
    }
  }

  if (kinds.includes("TRANSACTION")) return "TRANSACTION_STRUCTURED";
  if (bareTextOccurrences > 0 || kinds.includes("NONE")) return "UNSTRUCTURED";
  if (kinds.length > 0 && kinds.every((k) => k === "NON_TRANSACTION")) return "NON_TRANSACTION";
  return "UNSTRUCTURED";
}

export interface DocumentaryLocatorInput {
  // What extraction proposed, verbatim and untrusted. null/absent is the
  // normal case.
  claimedLocator: string | null | undefined;
  // The EXACT text the extractor was given — the same value D-076's
  // traceability check runs against, so "the document" means one thing.
  documentText: string;
  // The project's confirmed chain, when one exists. Decides which
  // identifier family a proposal must fit. Absent means "no confirmed
  // chain": any family's complete shape is accepted, none is attributed.
  chain?: SupportedChain | null;
  // The page's structured links, when the fetch produced them. Used only to
  // classify an EVM transaction-shaped value; absent (a saved document) means
  // the text alone decides, and a bare value stays admissible.
  links?: readonly StructuredLink[] | null;
}

export function validateDocumentaryLocator(
  input: DocumentaryLocatorInput,
): DocumentaryLocatorOutcome {
  const raw = input.claimedLocator;
  if (typeof raw !== "string") return { locator: "NONE", reason: "NOT_CLAIMED" };
  const value = raw.trim();
  if (value.length === 0) return { locator: "NONE", reason: "NOT_CLAIMED" };

  // Checked BEFORE the shape test so an abbreviated identifier reports
  // what it actually is, rather than the generic "not an identifier".
  if (isTruncatedDisplayForm(value)) {
    return { locator: "NONE", reason: "TRUNCATED_DISPLAY_FORM" };
  }
  const shape = completeIdentifierShape(value, input.chain ?? null);
  if (!shape) return { locator: "NONE", reason: "NOT_A_COMPLETE_IDENTIFIER" };
  if (!literallyPresent(input.documentText, value)) {
    return { locator: "NONE", reason: "NOT_LITERAL_IN_DOCUMENT" };
  }
  // EVM transaction-shaped values only. Base58 values and addresses are
  // untouched by this step.
  if (shape === "SIGNATURE_LIKE" && EVM_TRANSACTION_HASH.test(value)) {
    const reference = classifyEvmTransactionReference({
      value,
      documentText: input.documentText,
      links: input.links ?? null,
    });
    if (reference === "NON_TRANSACTION") {
      return { locator: "NONE", reason: "NOT_A_TRANSACTION_REFERENCE" };
    }
    return {
      locator: "CONFIRMED",
      value,
      shape,
      transactionStructured: reference === "TRANSACTION_STRUCTURED",
    };
  }
  return { locator: "CONFIRMED", value, shape };
}
